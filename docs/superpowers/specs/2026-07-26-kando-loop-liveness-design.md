# kando-loop liveness: periodic checks instead of silent waits

**Date:** 2026-07-26
**Status:** approved, ready for planning

## Problem

`/kando-loop` sometimes goes quiet and never resumes. Neither `commands/kando-loop.md`
nor `skills/kando-autonomous-loop/SKILL.md` says how to *wait*, so the loop inherits
the harness defaults, and both are failure-prone:

1. **Open-ended blocking.** The worker's step 7 runs `gh run watch <run-id>` in the
   foreground. A queued or wedged deploy blocks the subagent with no heartbeat and no
   deadline. This is the hang that was actually observed.
2. **Notification dependence.** `Agent` dispatches run in the background by default,
   so the coordinator resumes only when a completion notification arrives. Every
   worker dispatch, reviewer dispatch, and `SendMessage` round-trip in the review
   inner loop is a single point where a lost signal strands the run.

A second problem sits underneath: `gh run watch` hardcodes GitHub Actions. A GitLab
repo, or one with no CI that just runs its tests, has no path through step 7.

## Goals

- The loop never stalls silently. Every wait either resolves or emits a visible
  heartbeat.
- Verification works on any repo, without a list of supported CI systems.
- A wrong or broken verification probe announces itself; it can never quietly pass a
  ticket.

## Non-goals

- Working multiple tickets concurrently. The coordinator stays strictly sequential.
- A time ceiling on waiting. See "Accepted tradeoffs".

## Design

### 1. The waiter

A new shipped asset, `assets/kando-verify-wait.mjs`, installed by `init` into
`.claude/hooks/` alongside the existing `kando-workflow.mjs`.

**Interface:** `node .claude/hooks/kando-verify-wait.mjs --probe '<shell command>'`

The script contains no knowledge of any CI system. Its entire contract is the exit
code of the probe command it is given:

| Probe exit | Meaning |
|---|---|
| `0` | green |
| `1` | red |
| `2` | still pending |
| anything else | malformed probe |

**Polling.** Backoff 30s → 60s → 300s, capped. A heartbeat line goes to stdout only
on status change or every ~5 minutes, echoing the probe command being run. While the
probe reports pending, the script runs indefinitely.

**Per-invocation timeout.** Any single probe run exceeding ~60s is killed and counted
as pending, so a hanging `gh`/`curl` call cannot wedge the poller.

**Exit codes of the waiter itself:** `0` green, `1` red, `3` malformed probe.

**Flags:** `--interval-ms` and `--probe-timeout-ms` override the timing, for tests and
debugging.

### 2. Composing the probe (the LLM's job)

Detection lives in `SKILL.md`, not in the script. Hardcoded sniffing of
`.github/workflows` / `.gitlab-ci.yml` was considered and rejected: any rule list is a
list of repos it silently gets wrong (Jenkins, CircleCI, Buildkite, Drone, a `Makefile`
target, `cargo test`, monorepo path filters).

The split is by failure mode. Working out how a repo verifies a commit is judgment,
needs the repo in context, and has a long tail — an LLM does it well. Asking that
question every 30 seconds for an hour without drifting or mistaking silence for
success is mechanics — a script does it well.

**The coordinator composes the probe once per run**, at loop start, and passes the
same template to every worker with each ticket's sha substituted. One judgment call
per run, not one per ticket.

`SKILL.md` carries two or three worked examples — a `gh run list --json` one-liner, a
`glab` equivalent, `npm test` — explicitly labelled as *illustrations, not a menu*.

`SKILL.md` must also state one trap explicitly, because it is the failure the never-halt
policy turns into an infinite wait: **a probe must not return `2` when no run will ever
exist.** A push filtered out by path rules or branch conditions triggers no pipeline at
all, and a naive "no run found yet → pending" probe then polls forever. The composed
probe is responsible for distinguishing "no run yet" from "no run coming" — e.g. by
returning `0` once the sha is on the target branch and no run has appeared within the
probe's own grace period.

If no probe can be composed, the waiter is not armed and the loop degrades to the
behavior already documented in `SKILL.md`: a green local build is the gate.

### 3. Loop contract changes

**The long wait leaves the worker.** Worker step 7 becomes: merge to `main`, push,
report **`pushed`** with the commit sha, stop. It no longer watches any deploy.

**The coordinator owns the wait:**

1. Worker reports `pushed`.
2. Coordinator arms `Monitor` with `persistent: true`, running
   `kando-verify-wait.mjs --probe '<probe with sha>'`, then ends its turn.
3. Each heartbeat arrives as an event and re-invokes the coordinator, which stays
   visible and does nothing else.
4. Green → `SendMessage` the worker `verified green, finish up`; the worker moves the
   ticket to the last column, records the deep link, reports `done`.
   Red → halt the run and surface the probe output.
   Malformed → halt and report; never treated as green.

The worker finishes the ticket rather than the coordinator doing it, because
`SendMessage` resumes it with its context intact and the skill's stated goal is to
keep the coordinator's context lean.

**Everything else becomes synchronous.** Worker dispatch, reviewer dispatch, and the
review round-trips all use `run_in_background: false`. The coordinator is strictly
sequential and needs each result before continuing, so backgrounding them buys nothing
and is what makes a lost notification fatal.

This yields one rule to state directly in `SKILL.md`:

> **No wait may depend on a single notification that might not arrive.** Short waits
> are synchronous calls; the one genuinely long wait is a heartbeat stream.

**Consequence:** the coordinator's step-5 verification simplifies. It *observed* green
directly, so it only re-checks ticket state via `get_ticket` rather than re-deriving
the deploy status from git and `gh`.

### 4. Implementation shape

`assets/kando-verify-wait.mjs` is self-contained plain ESM importing nothing beyond
`node:child_process` — the same constraint as `kando-workflow.mjs`, since it runs
standalone in the target repo where nothing else is installed.

It exports its pure functions (`nextDelay`, `classifyExit`, `shouldHeartbeat`) and
guards the CLI entry on `import.meta.url`, so vitest imports the asset directly. There
is no generated file and no build step, so the thing under test is the thing that
ships.

This departs from how `kando-workflow.mjs` is tested. That asset duplicates
`GATE_TEXT` and `src/hook.test.ts` guards the copies with a string-match drift test —
fine for a constant, but the waiter's logic is real behavior and duplicating it would
be fragile. Importing the asset directly is the reason it exports its internals.

`init` copies it to `.claude/hooks/kando-verify-wait.mjs`, next to the existing hook.

### 5. Testing

Tests live at `src/verifyWait.test.ts`, alongside every other test in this repo.
Because `tsconfig.json` includes only `src` and has `allowJs` off, the test loads the
asset through a **dynamic import with a runtime-constructed specifier** (the URL held
in a variable), so `tsc --noEmit` cannot try to resolve the untyped `.mjs` and stays
green. Integration cases spawn the asset as a subprocess instead.

**Pure**
- backoff sequence 30/60/300, capped
- heartbeat fires on status change and on the 5-minute tick, and not otherwise
- `classifyExit` across 0, 1, 2, 3, 127

**Integration** — spawn the asset with shrunk timings and assert exit code and stdout:
- `--probe 'exit 0'` → 0
- `--probe 'exit 1'` → 1
- `--probe 'exit 3'` → 3, malformed reported loudly
- `--probe 'sleep 999'` → per-invocation timeout, counted as pending

**init** — asserts the asset lands in `.claude/hooks/`.

## Constraints that shaped the design

- `Monitor` auto-stops a source emitting too many events. The heartbeat budget is
  ~12/hour, which is why it is "on change or every 5 min" rather than every poll.
- Foreground `Bash` is capped at 10 minutes, so it cannot host the wait.
- `Bash` with `run_in_background` gives exactly one notification, on exit — useless for
  a wait that may never terminate. Hence `Monitor`.

## Accepted tradeoffs

- **No time ceiling.** A probe stuck on `2` polls forever, holding the run open. This
  was chosen deliberately over halting after a deadline, to avoid false halts on slow
  but healthy pipelines. The 5-minute heartbeat is the mitigation: the stall is
  visible and interruptible rather than silent.
- **No committed probe config.** Detection happens at runtime with nothing to inspect
  beforehand. The mitigation is that the waiter echoes its probe command in every
  heartbeat, so the choice is visible in the transcript.
- **Probe non-determinism.** Different runs may compose different probes for the same
  repo. Acceptable, and visible for the same reason.

## Open question for implementation

Whether a synchronous `Agent` dispatch has its own hard time cap. If it does, worker
dispatch falls back to background dispatch plus the same heartbeat treatment. Verify
this before rewriting the dispatch steps.

## Files touched

- `assets/kando-verify-wait.mjs` — new
- `src/verifyWait.test.ts` — new
- `src/init.ts` — copy the new asset
- `src/init.test.ts` — assert the copy
- `skills/kando-autonomous-loop/SKILL.md` — probe composition, `pushed` state,
  coordinator-owned wait, synchronous dispatch, the no-silent-wait rule
