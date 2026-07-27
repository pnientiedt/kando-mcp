---
name: kando-autonomous-loop
description: Use when asked to autonomously work one or more Kando targets — boards, stories, or subtasks — to completion, e.g. via /kando-loop. Runs a coordinator loop that dispatches one worker subagent per ticket until nothing workable remains.
---

# Kando autonomous work loop

Work one or more Kando **targets** (board keys and/or `KEY-N` stories/subtasks) autonomously: a **coordinator loop** dispatches a **fresh worker subagent per ticket**, gates each ticket behind TDD and an **independent review**, and continues until nothing workable remains — across every target given, in order. Running `/kando-loop` authorizes spawning worker + reviewer subagents for this task.

**Work is ticket-at-a-time; shipping is batch-at-a-time.** Tickets accumulate on one
`kando-loop/<run-id>` branch, and the coordinator merges to `main` and runs the repo's
full verification once per **batch** — normally a completed story. A story with ten
subtasks costs one deploy and one full suite run, not ten. See "Batching and the flush".

**REQUIRED BACKGROUND:** the `kando` skill (the record-then-code gate) and the `test-driven-development` skill. Every worker follows both.

## Coordinator loop

You may be given **one OR MORE targets** (space-separated, e.g. `TSK-1 TSK-2 TSK-3` — board keys and/or `KEY-N` stories/subtasks, mixed). Process them **in order**. Keep your own context lean — you never implement or review; a worker implements, an independent reviewer judges. **Safety counters are cumulative across the whole run** — all targets share one budget.

**Before the first ticket, compose this repo's verification commands — once per run.** Read the repo — CI config, `Makefile`, `package.json` — and work out how *it* decides a commit is good, rather than assuming a provider. There are two commands, and you need **at least one**:

- **`--watch` (primary): a command that BLOCKS until the outcome is known**, then exits `0` green / `1` red. This is the fast path — it returns within seconds of the work finishing.
- **`--probe` (safety net): a command that QUERIES current status and returns immediately**, exiting `0` green / `1` red / `2` still pending. It is polled on a backoff, and exists so a watch that hangs or dies can never strand the loop.

Illustrations, **not a menu** — a Buildkite or Jenkins repo gets commands you write by reading it:

| Repo | `--watch` | `--probe` |
|---|---|---|
| GitHub Actions | `gh run watch <run-id> --exit-status` | `s=$(gh run list --commit <sha> --json status,conclusion --jq 'if length==0 then 2 elif (.[0].status!="completed") then 2 elif (.[0].conclusion=="success") then 0 else 1 end'); exit "${s:-3}"` |
| GitLab CI | `glab ci status --sha <sha> --wait` | `glab ci status --sha <sha>` wrapped to map to 0/1/2 |
| **No CI at all** | **the repo's own test command, e.g. `npm test`** | *(none — omit it)* |

**A local test suite is a watch, never a probe.** It blocks, it takes as long as it takes, and there is no status to query. Passing it as `--probe` is a bug: probes carry a short per-invocation timeout, so a suite slower than that gets killed, reported `pending`, and re-run forever — a suite that PASSES never produces a verdict. Pass it as `--watch` and omit `--probe` entirely.

**The verdict must be the command's exit code, not something it prints.** `gh ... --jq '...'` *prints* the number and exits 0 because `gh` itself succeeded — a probe ending `; exit $?` therefore reports **green for a still-pending run**. Capture the output and exit with it, as above. The `${s:-3}` fallback matters too: if the CLI fails outright the substitution is empty, and `3` halts the loop loudly instead of silently passing the ticket.

**A probe must never return `2` when no run will ever exist.** A push filtered out by path rules or branch conditions triggers no pipeline, and a naive "no run found yet → pending" probe then polls forever. Give the probe its own grace period: once the sha is on the target branch and no run has appeared within it, return `0`.

If you can compose neither, skip the wait entirely and fall back to the green-local-build gate described in the worker prompt.

**These commands are armed once per FLUSH, not once per ticket.** Tickets are worked one
at a time and **shipped in batches** — see "Batching and the flush". That is the whole
point of this design: a story with ten subtasks costs one deploy and one full suite run,
not ten.

**Before the first ticket, cut the run's loop branch.** Every ticket lands there; only
you ever touch `main`.

- A **dirty working tree is a hard stop.** Refuse to start rather than sweep somebody's
  uncommitted work into a batch you are going to ship to production.
- Bring `main` up to date (`git checkout main && git pull --ff-only`), then
  `git checkout -b kando-loop/<run-id>`, where `<run-id>` is a `YYYYMMDD-HHMMSS`
  timestamp.
- **One branch serves the whole run**, including a multi-target run spanning several
  boards. After each green flush it is fast-forwarded to `main` and reused.

**On each board's first ticket, call `get_board` once — then never again for that
board.** Pass **`fields: ["board", "members"]`**: you need the columns and the bot's
`userSub`, not every ticket, tag, and release on the board. The worker does not call it. Cache three things per board: the bot member's
`userSub`, the in-progress column, and the last column. Key this **per board, not per
run** — a multi-target run can span several boards.

Restate the cache as a compact run header at the top of **every** turn:

```
branch kando-loop/20260727-153000 | batch TSK-11, TSK-12
board TSK → userSub abc-123, in-progress "In Progress", last "Done"
```

You end your turn during the flush verification wait and are re-invoked by heartbeats,
so anything held only in context does not survive. If the header is missing when you
resume, rebuild it: `get_board` for the board you are on, `git branch --show-current`
for the branch, and the **`pending-ship` tickets on the board** for the batch — which is
exactly why the hold is a tag and not a list in your head. Worst case that costs one
fetch per interruption — still far below one per worker.

**For each `target` in the list, in order, repeat until it is exhausted:**

1. Call `next_task(target)` — **unless step 7 already did**, in which case use the result it hands you. If it returns `{ "none": true }` → this target is **exhausted**: go to the **next target** (or, if it was the last, **flush what is on the branch, then stop — success**).
2. Enforce safety BEFORE dispatching (cumulative across all targets):
   - If `done + human-needed ≥ 25` → **flush, then stop (max-tasks)**.
   - If the last **3** results in a row were `human-needed` → **flush, then stop (circuit breaker)**.
3. Record the ticket's **base sha** (`git rev-parse HEAD`, on the loop branch) — one line of output, and the reviewer's diff range for every round of this ticket. Then dispatch ONE worker subagent (Agent tool, **`subagent_type: kando-worker`**, **`model: sonnet`**, **`run_in_background: false`**) with the **worker prompt** below for the ticket `KEY-N`, substituting this board's cached `<userSub>`, `<in-progress column>`, and `<last column>` into it. It works TDD-first, commits **locally (no push)**, and reports `ready-for-review` (or `blocked`).
4. **Independent review inner loop** (max **3** rounds) — while the worker reports `ready-for-review`:
   a. Dispatch a **fresh, independent reviewer subagent** (Agent tool, **`subagent_type: kando-reviewer`**, **`model: sonnet`**, **`run_in_background: false`**) with the **reviewer prompt** below, giving it the ticket intent and the **diff range** `<base-sha>..HEAD`. **Never run `git diff` yourself and never paste a diff into the prompt** — that pays for it twice, once in your context and once in the reviewer's, and you never read it. The reviewer runs the diff itself. Every round uses the SAME base sha, so each fresh reviewer sees the complete ticket diff, not just the latest fix. It returns a BLOCKING list and an ADVISORY list.
   b. **No blocking findings** → SendMessage the worker: `review passed — push the branch`. Go to step 5.
   c. **Blocking findings** → SendMessage the worker the findings. It fixes, recommits, and reports `ready-for-review` again. `round++`.
   d. If `round > 3` and still blocking → SendMessage the worker: `block it: <findings>`. It tags `human-needed` + writes a Blocked note; treat the result as `blocked`.
   - Advisory findings never block and never trigger a round; the worker may apply low-risk ones or note them in the Done section.
5. **When the worker reports `pushed`** (its commit is on `kando-loop/<run-id>`), put the ticket into the **hold state**. **There is no pipeline wait here** — that is what changed:
   - `ensure_tag <board> pending-ship`, then `update_ticket KEY-N` to apply it, **keeping every tag the ticket already has**. Leave it in the in-progress column: it is not Done until it ships.
   - Add `KEY-N` to this run's **batch list** and restate that list in your run header.
   - The **tag**, not the list, is the durable record. `next_task` skips a `pending-ship` ticket — the only reason the loop can advance past its own finished work — and if this session dies, the board still shows exactly what is parked on the branch.
6. Read the worker's final report and **verify** it via `get_ticket`:
   - `pushed` → the ticket MUST carry `claude` + `pending-ship`, sit in the in-progress column, and have `## 🤖 Claude — Plan` and `## 🤖 Claude — Done` sections. It is **not** Done — you set that at the flush.
   - `blocked` → the ticket MUST carry `claude` + `human-needed`. Count it toward the circuit breaker.
7. **Decide whether to flush**, then loop back to step 1 for the **same target**. Call `next_task(target)` here and carry its result into step 1 — one call, used for both.

   Two things govern this, and they are different in kind. **Container stories are a hard rule. Everything else is judgement.**

   **Hard rule — a container story ships WHOLE.** It applies when the ticket you just finished was a **subtask**:
   - next task's `storyId` is the **same** → **never flush**. Half a story in production is the outcome this design exists to prevent, whatever else is on the branch.
   - next task's `storyId` **differs**, or it returned `{ "none": true }` → the container is complete → **flush**.

   **Judgement — is this a meaningful package?** Everywhere else, and in particular when you have just finished a **standalone story**, ask the one question that matters: *has enough accumulated that a person would deliberately deploy it — real impact, sensible scope?*
   - a substantial bug fix, a self-contained feature, a set of related fixes → **yes, flush.** A meaningful standalone story earns its own deploy; do not make it wait.
   - a chore, a flaky-test fix, a docs or config tweak, a one-liner → **no.** It parks on the branch and rides along with the next batch, which costs it nothing and saves a deploy nobody wanted.

   **Never let a bare `storyId` comparison stand in for that judgement.** `next_task` sets `storyId` only for subtasks, so a standalone story reports `undefined`. `undefined` against the next ticket's `storyId` is not a boundary — it is the *absence* of a story. Reading it as one is how a one-line flaky-test fix buys itself a production deploy.

   A run of nothing but standalone stories therefore has no hard rule at all: it is judgement the whole way, plus the exit flush, which guarantees nothing is stranded.

Final summary: cumulative counts of done / human-needed / skipped, the stop reason, and — if a limit tripped mid-run — which target it stopped on. Also report the **loop branch name**, the **batches shipped** (merge sha per batch), and any tickets left `pending-ship`.

## Batching and the flush

A **flush** is the only thing that ships: merge the loop branch into `main`, push,
deploy, and run the repo's full verification once for the whole batch. **You** do this —
never a worker. Three things trigger one:

- **a container story completes** — step 7's `storyId` comparison after a **subtask**, or
  `{ "none": true }`. This one is a hard rule: a container ships whole, never in halves;
- **your judgement that what has accumulated is a meaningful package** — real impact,
  sensible scope, something a person would deploy on purpose. This is what decides after
  a **standalone story**: a substantial fix earns its own deploy, a chore or a
  flaky-test fix rides along with the next batch;
- **the run is about to exit** — for *any* reason: target exhausted, max-tasks, circuit
  breaker. Nothing is ever left silently unshipped. (The one exception is a red flush
  that exhausted its fixers: it has already reverted, and there is nothing to ship.)

**The loop BLOCKS on a flush.** No ticket starts until the verdict lands.

### The procedure

**An empty batch is not a flush.** If the batch list is empty — every stop path calls for
a flush, and step 7 has usually just done one — there is nothing to merge. Skip it
silently; do not construct an empty merge commit.

1. **Merge and push.** `git checkout main && git pull --ff-only`, then
   `git merge --no-ff kando-loop/<run-id>` with a message naming **every ticket in the
   batch**, then `git push origin main`. Record the **merge sha**.
2. **Arm the waiter against the merge sha** and **end your turn** — the mechanism is
   exactly the one this loop has always used, only far less often:
   - `Monitor` with `persistent: true`, command `node .claude/hooks/kando-verify-wait.mjs`
     with whichever of `--watch '<cmd>'` / `--probe '<cmd>'` you composed at run start
     (at least one, both when both exist), substituting the **merge sha** and — for a
     `gh run watch`-style watch — the run id you looked up from it.
   - Each heartbeat re-invokes you. While the status is `pending`, do nothing but stay
     visible — there is no deadline, by design.
3. **Waiter exits `0` (green) — the batch has shipped.** For **each** ticket in the
   batch, you do the board writes yourself:
   - `update_ticket` to **remove `pending-ship`** (keep `claude` and everything else);
   - `move_ticket` to the **last column**;
   - write the **deep link** — the `main` commit URL, plus the pipeline run URL — into
     its `## 🤖 Claude — Done` section.

   Then `git checkout kando-loop/<run-id> && git merge --ff-only main` to carry the
   branch forward, clear the batch list, and continue.

   *You* do these writes because the batch's workers finished their turns long ago, and
   you already hold `update_ticket` and `move_ticket`. Do not try to resurrect them.
4. **Waiter exits `1` (red)** → see "When a flush goes red" below.
5. **Waiter exits `3`** → **stop the whole loop**. Either the probe is malformed, or a
   watch went unavailable with no probe to fall back on. Neither fixes itself by being
   retried. Report the exit code and the commands. **Never treat this as green.**
6. **Neither command was composable for this repo** → skip step 2 entirely: the merge
   lands, do the step-3 board writes immediately, and the gate is the workers' green
   local builds.

### When a flush goes red

`main` and production are **broken**. Say so **prominently** in your output — not buried
in a status line. Then fix forward, twice at most:

1. **`git checkout kando-loop/<run-id>` first.** The merge left your working tree on
   `main`, and the fixer must not work there. Then dispatch a **`kando-worker`**
   (`subagent_type: kando-worker`, `model: sonnet`, `run_in_background: false`) on a
   **synthetic brief** — create **no** board ticket. Give it: the failing run's output
   and URL, the merge sha, the batch's ticket keys, and the diff range to read. Tell it
   it is on the loop branch, which already holds the whole batch (`main` differs only by
   the merge commit); that it must keep TDD wherever the failure has a testable surface;
   and that it commits, pushes the branch, and reports `ready-for-review`.
2. Dispatch a **fresh `kando-reviewer`** on the fixer's own diff range — same inner loop,
   same **3**-round cap. A fixer that papers over a real bug is exactly what this gate
   exists to catch.
3. Review passes → **re-flush** from step 1 of the procedure.

**Bounded at 2 fixer attempts per red flush**, and the count **resets on green**. On
exhaustion:

- `git revert -m 1 <merge-sha>` and push — `main` and production return to the last
  green state. The loop branch keeps every commit, so nothing is lost, only unshipped.
- Write a `## 🤖 Claude — Blocked` section on **every** ticket in the batch, naming the
  red run and what both fixers tried.
- **Stop the loop**, reporting the merge sha, the run URL, the revert sha, the batch's
  tickets, and both fixer attempts.

Fixer attempts count toward **none** of the budgets — not `done`/`human-needed`, not the
circuit breaker, not max-tasks. A fix is not a ticket; it has its own bound.

**This leaves a deliberate manual-recovery point.** The batch's tickets keep
`pending-ship`, so no later run will re-select them. That is correct: their code is
written and reviewed, and re-working it is not the recovery. A human reads the Blocked
notes and decides. The loop does not dig itself out.

## Model tiering — deliberate, not an oversight

Workers and reviewers are dispatched with an explicit **`model: sonnet`**. Both execute
against criteria that are already written down: the worker implements TDD against the
ticket's `## 📋 Specification`, the reviewer judges a diff against stated intent. A run
can boot 50–100 of these agents, so their tier dominates its cost.

**You are the exception — do not override your own model.** The coordinator keeps the
session model, because it holds the judgment seats: interpreting a waiter exit code,
tripping the circuit breaker, deciding `block it`. Those are where a wrong call is
expensive and rare enough not to matter to cost.

**Never drop the reviewer to `haiku`.** Its hardest task is judging whether tests are
trivial, gamed, or clearly not written test-first — the exact discrimination the review
gate exists to make, and the last thing to cheapen.

## Both subagents are tool-restricted — for safety, not for tokens

`kando-mcp init` installs two agent definitions into `.claude/agents/`, and the loop
dispatches them by `subagent_type`:

- **`kando-reviewer`** has no board tools and no edit tools. It *cannot* move a ticket or
  push, so the independence the review gate depends on is enforced by its toolset rather
  than by asking nicely.
- **`kando-worker`** holds 8 of the server's 21 board tools — enough to read a ticket,
  update and move the one it was given, ensure a tag, and create a story or subtask to
  record a finding. It has **no** `delete_ticket`, `archive_ticket`, `delete_tag`, or
  `delete_release`. This loop runs unattended, with standing authorization to push,
  across up to 25 tickets; nothing destructive should be within reach of the agent doing
  the work.

**The token saving is small** — MCP schemas load on demand, so a restriction drops tool
*names*, not full schemas. Take these restrictions for the blast radius they remove.

**If either agent type is unavailable** — an older `init`, a repo where the files were
not installed, or a session started *before* they were — the dispatch fails with
`Agent type not found`. That is a hard error, not a silent fallback: catch it, re-dispatch
that one agent as `general-purpose`, and carry on. The loop still works; it just leans on
the prompt for the guarantees the toolset would have enforced. **Agent definitions are
read at session start**, so a fresh `init` does not take effect until the session is
restarted.

## Worker prompt (one ticket; hands back to the coordinator at the review gate)

Dispatch a general-purpose subagent with this instruction (substitute the real `KEY-N`):

> You are a Kando worker. Work ONLY ticket **KEY-N**. Follow the `kando` skill's record-then-code gate AND the `test-driven-development` skill. Steps:
> 1. **Tag `claude` FIRST — before anything else.** `ensure_tag <board> claude`, then `update_ticket KEY-N` to apply its id (keep any tags the ticket already has), so the board shows it's being worked.
> 2. `get_ticket KEY-N`. Assign the ticket to `<userSub>`, move it to the `<in-progress column>` column, and append a `## 🤖 Claude — Plan` section (preserve the original body). **Do NOT call `get_board`** — the coordinator has already given you every board value you need. **If the body has a `## 📋 Specification` section, that is the authoritative spec — build to it (do not re-derive intent from the title).**
> 3. **TDD — write failing test(s) FIRST (RED).** Before any implementation, add test(s) covering the ticket's intended behavior using the repo's **existing** test suites/frameworks (match their patterns; do not invent a parallel harness). Run them and confirm they **fail for the right reason**. If a `## 📋 Specification` section exists, write these tests against its **Acceptance criteria**. *Exemption:* only if the change has genuinely no testable runtime surface (pure docs/config) — state that and why in the Plan section; the reviewer will verify it.
> 4. **Implement to green (GREEN).** Minimal code to make those tests pass; then run the full suite (and build, if any) and confirm it is green.
> 5. **Commit LOCALLY — do NOT push.** You are on the run's `kando-loop/<run-id>` branch; stay on it and never switch. Append a `## 🤖 Claude — Done` section. `git commit`. Then **report `ready-for-review`** and STOP — do not push. The coordinator will have an independent reviewer look at your diff.
> 6. **When the coordinator sends review findings:** fix every BLOCKING one, keep the suite green, `git commit`, and report `ready-for-review` again. (Apply low-risk ADVISORY suggestions too, or note them in the Done section.)
> 7. **When the coordinator says `review passed — push the branch`:** push the run's loop branch `kando-loop/<run-id>` — the branch you are already on. **Never push `main`, never merge into `main`, and never open a PR.** Running `/kando-loop` authorizes this push; do NOT stop to ask. Then report **`pushed`** with the commit sha and STOP. The coordinator decides when your ticket's batch ships and owns every pipeline wait: **do not watch a pipeline, and do not move the ticket to the last column** — it is not Done until the batch is verified green on `main`, and the coordinator records that itself.
> 8. **When the coordinator says `block it`:** `ensure_tag <board> human-needed`, apply it (keep `claude`), append a `## 🤖 Claude — Blocked` section with the outstanding findings and what you tried, leave the ticket un-shipped, report **`blocked`**.
> **Run long commands in the FOREGROUND — never `run_in_background`.** Test suite, build, install, e2e run: sit through it. You are a subagent, so ending your turn is *terminal*, and a background job's completion notification is delivered to the **coordinator**, not to you — park yourself waiting for one and you stop before committing, stranding the work. If a command would outlast the foreground timeout, narrow it (one suite, one spec) and say so; do not background it. The "never block in your own foreground" rule elsewhere in this skill is addressed to the coordinator and does **not** apply to you.
> Report exactly one word each turn — `ready-for-review`, `pushed`, or `blocked` — with a one-line reason. There is no `done` for you to report: only the coordinator can mark a ticket Done, and only after its batch is green on `main`. Never push before the coordinator says the review passed.

## Reviewer prompt (independent — never the implementer)

Dispatch a FRESH general-purpose subagent (it did NOT write this code) with:

> You are an INDEPENDENT code reviewer for Kando ticket **KEY-N**. You did not write this change; do not trust any implementer narrative. You are given the ticket **intent** (title/body/Plan) and a **diff range**. **Run `git diff <base-sha>..HEAD` yourself** — that is the complete change under review. Review the diff directly and sort findings into two buckets and report both. (Do NOT try to invoke the `/code-review` skill — it can't be called by a subagent; apply code-review principles yourself.)
> - **BLOCKING** (must be fixed before this ships):
>   - **correctness** — real bugs, logic errors, unhandled edge cases in the diff;
>   - **adherence** — the change does not actually do what the ticket asked, or cuts corners; OR the tests are trivial / gamed / do not exercise the change / were clearly not written test-first; OR the change claims a "no testable surface" TDD exemption but a testable surface plainly exists.
> - **ADVISORY** (do NOT block): quality — simplification, reuse, efficiency, style.
> Be strict on adherence and test quality — catching shallow work is the entire point of this gate. Output the BLOCKING list (empty if clean) and the ADVISORY list, each finding one line with `file:line`.

## The `human-needed` bar is HIGH — solve it yourself first

`human-needed` is a **last resort**, never a convenience or a courtesy. Set it ONLY when it is genuinely **impossible to proceed without a human**. Before a worker may report `blocked` it MUST have read the code, tried alternative approaches, used systematic debugging, and made a real attempt to reach green.

**Legitimate triggers (narrow):**
- a product/scope decision only a human can make (genuinely ambiguous intent, no defensible default);
- missing access / credentials / permissions the worker cannot obtain;
- an external human action the worker cannot perform.

**NOT triggers:** "this is hard", "I'm not fully sure", "it's tedious", "a human might prefer to weigh in". In those cases the worker **decides and proceeds**.

(A ticket the reviewer cannot pass in 3 rounds also lands as `human-needed` — that is the coordinator's `block it` path, separate from this bar.)

## No silent waits

**No wait in this loop may depend on a single notification that might not arrive.** That is the failure mode this design exists to remove.

- Short waits — worker dispatch, reviewer dispatch, review round-trips — are **synchronous** (`run_in_background: false`). The coordinator is strictly sequential and needs each result before continuing, so backgrounding them buys nothing and makes a lost notification fatal.
- The one genuinely long wait — **verification after a flush** — is a **heartbeat stream** via `Monitor`, never a blocking call *of yours*. **Never run a pipeline watch (`gh run watch` or any equivalent) in your own foreground:** it blocks with no heartbeat, and a foreground command is capped at 10 minutes anyway — that combination is the original hang this design removed. A blocking watch is fine *inside* the waiter, where it is raced against the poll and the waiter is the thing emitting heartbeats. The rule is about who blocks, not about blocking.
- A wait that produces no output is indistinguishable from a wait that died. If you are waiting, something must be emitting.
- **A permission prompt is a silent wait too.** `kando-mcp init` pre-grants the board tools this loop calls, so an unattended run never blocks on one. If a dispatch reports a missing permission, the repo was installed by an older `init` — re-run it rather than sitting there. The destructive tools are deliberately *not* pre-granted, and the `kando-worker` agent withholds them independently.

## Never

- **Never mark a ticket `done` before its batch's merge commit is on `main` AND the verification has gone green.** A ticket sitting on the loop branch under `pending-ship` is NOT done, however finished and well-reviewed it is. Only **you** set `done`, and only at step 3 of a green flush.
- **Never let a worker push `main`.** Workers push `kando-loop/<run-id>` and nothing else; the merge is yours alone.
- **Never exit the run with work left on the branch.** Every stop path flushes first — the sole exception being a red flush that exhausted its fixers and already reverted.
- **Never flush mid-container-story.** A container ships whole, as one deploy; half of one in production is the failure this design exists to prevent.
- **Never ship a batch nobody would deploy on purpose.** A chore, a flaky-test fix or a docs change does not earn a deploy of its own — it rides along. A meaningful standalone story does, and should not be made to wait.
- Never stop the loop to ask for deploy authorization — `/kando-loop` is the standing authorization to push the loop branch, merge it to `main`, and deploy.
- Never push before the independent review passes. The reviewer is NEVER the implementer — always a fresh, separate agent.
- Never skip TDD when the change is testable; never accept a false "no testable surface" exemption.
- Never push a red build. Never mark `done` on a red or malformed verification. Never work a ticket assigned to a human. Never lower the `human-needed` bar to skip hard work.
- **Never start a NEW ticket while a flush is red.** The only thing that may follow a red flush is a bounded fixer — two at most — and then a revert and a stop.
