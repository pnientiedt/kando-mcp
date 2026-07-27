---
name: kando-autonomous-loop
description: Use when asked to autonomously work one or more Kando targets — boards, stories, or subtasks — to completion, e.g. via /kando-loop. Runs a coordinator loop that dispatches one worker subagent per ticket until nothing workable remains.
---

# Kando autonomous work loop

Work one or more Kando **targets** (board keys and/or `KEY-N` stories/subtasks) autonomously: a **coordinator loop** dispatches a **fresh worker subagent per ticket**, gates each ticket behind TDD and an **independent review**, and continues until nothing workable remains — across every target given, in order. Running `/kando-loop` authorizes spawning worker + reviewer subagents for this task.

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

**On each board's first ticket, call `get_board` once — then never again for that
board.** Pass **`fields: ["board", "members"]`**: you need the columns and the bot's
`userSub`, not every ticket, tag, and release on the board. The worker does not call it. Cache three things per board: the bot member's
`userSub`, the in-progress column, and the last column. Key this **per board, not per
run** — a multi-target run can span several boards.

Restate the cache as a compact run header at the top of **every** turn:

```
board TSK → userSub abc-123, in-progress "In Progress", last "Done"
```

You end your turn during the step-5 verification wait and are re-invoked by heartbeats,
so a cache held only in context does not survive. If the header is missing when you
resume, re-fetch `get_board` for the board you are on. Worst case that costs one fetch
per interruption — still far below one per worker.

**For each `target` in the list, in order, repeat until it is exhausted:**

1. Call `next_task(target)`. If it returns `{ "none": true }` → this target is **exhausted**: go to the **next target** (or, if it was the last, **stop — success**).
2. Enforce safety BEFORE dispatching (cumulative across all targets):
   - If `done + human-needed ≥ 25` → **stop (max-tasks)**.
   - If the last **3** results in a row were `human-needed` → **stop (circuit breaker)**.
3. Record the ticket's **base sha** (`git rev-parse HEAD`) — one line of output, and the reviewer's diff range for every round of this ticket. Then dispatch ONE worker subagent (Agent tool, general-purpose, **`model: sonnet`**, **`run_in_background: false`**) with the **worker prompt** below for the ticket `KEY-N`, substituting this board's cached `<userSub>`, `<in-progress column>`, and `<last column>` into it. It works TDD-first, commits **locally (no push)**, and reports `ready-for-review` (or `blocked`).
4. **Independent review inner loop** (max **3** rounds) — while the worker reports `ready-for-review`:
   a. Dispatch a **fresh, independent reviewer subagent** (Agent tool, **`subagent_type: kando-reviewer`**, **`model: sonnet`**, **`run_in_background: false`**) with the **reviewer prompt** below, giving it the ticket intent and the **diff range** `<base-sha>..HEAD`. **Never run `git diff` yourself and never paste a diff into the prompt** — that pays for it twice, once in your context and once in the reviewer's, and you never read it. The reviewer runs the diff itself. Every round uses the SAME base sha, so each fresh reviewer sees the complete ticket diff, not just the latest fix. It returns a BLOCKING list and an ADVISORY list.
   b. **No blocking findings** → SendMessage the worker: `review passed — ship it`. Go to step 5.
   c. **Blocking findings** → SendMessage the worker the findings. It fixes, recommits, and reports `ready-for-review` again. `round++`.
   d. If `round > 3` and still blocking → SendMessage the worker: `block it: <findings>`. It tags `human-needed` + writes a Blocked note; treat the result as `blocked`.
   - Advisory findings never block and never trigger a round; the worker may apply low-risk ones or note them in the Done section.
5. **When the worker reports `pushed`** (with its commit sha), arm the waiter and **end your turn**:
   - `Monitor` with `persistent: true`, command `node .claude/hooks/kando-verify-wait.mjs` with whichever of `--watch '<cmd>'` / `--probe '<cmd>'` you composed (at least one, both when both exist), substituting the worker's sha and — for a `gh run watch`-style watch — the run id you looked up from that sha.
   - Each heartbeat re-invokes you. While the status is `pending`, do nothing but stay visible — there is no deadline, by design.
   - Waiter exits **0** → SendMessage the worker `verified green, finish up`. It moves the ticket to the last column, records the deep link, and reports `done`.
   - Waiter exits **1** → **stop the whole loop** — a red pipeline is an infra failure. Surface the output.
   - Waiter exits **3** → **stop the whole loop**. Either the probe is malformed, or a watch went unavailable with no probe to fall back on. Neither fixes itself by being retried. Report the exit code and the commands. **Never treat this as green.**
   - Neither command was composable for this repo → skip the wait; the worker's green local build is the gate.
6. Read the worker's final report and **verify** it via `get_ticket`:
   - `done` → the ticket MUST be in the last column, carry the `claude` tag, and have a deep link in its `## 🤖 Claude — Done` section. You already observed the verification go green in step 5, so re-check the ticket state via `get_ticket` — do not re-derive the pipeline status.
   - `blocked` → the ticket MUST carry `claude` + `human-needed`. Count it toward the circuit breaker.
7. Loop back to step 1 for the **same target**.

Final summary: cumulative counts of done / human-needed / skipped, the stop reason, and — if a limit tripped mid-run — which target it stopped on.

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

**The reviewer runs as `kando-reviewer`, a tool-restricted agent** that `kando-mcp init`
installs into `.claude/agents/`. It has no board tools and no edit tools, so it *cannot*
move a ticket or push — the independence the review gate depends on is enforced by its
toolset rather than by asking nicely. It also skips loading all 21 Kando tool schemas it
would never call.

**If that agent type is unavailable** (an older `init`, or a repo where the file was not
installed), fall back to `general-purpose` and carry on — the review still works, it just
costs more and leans on the prompt for independence.

## Worker prompt (one ticket; hands back to the coordinator at the review gate)

Dispatch a general-purpose subagent with this instruction (substitute the real `KEY-N`):

> You are a Kando worker. Work ONLY ticket **KEY-N**. Follow the `kando` skill's record-then-code gate AND the `test-driven-development` skill. Steps:
> 1. **Tag `claude` FIRST — before anything else.** `ensure_tag <board> claude`, then `update_ticket KEY-N` to apply its id (keep any tags the ticket already has), so the board shows it's being worked.
> 2. `get_ticket KEY-N`. Assign the ticket to `<userSub>`, move it to the `<in-progress column>` column, and append a `## 🤖 Claude — Plan` section (preserve the original body). **Do NOT call `get_board`** — the coordinator has already given you every board value you need. **If the body has a `## 📋 Specification` section, that is the authoritative spec — build to it (do not re-derive intent from the title).**
> 3. **TDD — write failing test(s) FIRST (RED).** Before any implementation, add test(s) covering the ticket's intended behavior using the repo's **existing** test suites/frameworks (match their patterns; do not invent a parallel harness). Run them and confirm they **fail for the right reason**. If a `## 📋 Specification` section exists, write these tests against its **Acceptance criteria**. *Exemption:* only if the change has genuinely no testable runtime surface (pure docs/config) — state that and why in the Plan section; the reviewer will verify it.
> 4. **Implement to green (GREEN).** Minimal code to make those tests pass; then run the full suite (and build, if any) and confirm it is green.
> 5. **Commit LOCALLY — do NOT push.** Append a `## 🤖 Claude — Done` section. `git commit`. Then **report `ready-for-review`** and STOP — do not push. The coordinator will have an independent reviewer look at your diff.
> 6. **When the coordinator sends review findings:** fix every BLOCKING one, keep the suite green, `git commit`, and report `ready-for-review` again. (Apply low-risk ADVISORY suggestions too, or note them in the Done section.)
> 7. **When the coordinator says `review passed — ship it`:** land the change on **`main`** — if you worked on a branch, merge it with `git merge --no-ff` (or commit directly on `main`), then **push `main`**. Running `/kando-loop` authorizes this — it is a standing pre-authorization to deploy; do NOT stop to ask, and do NOT leave the work on a branch or an open PR. Then report **`pushed`** with the commit sha and STOP. **Do not watch any pipeline yourself** — the coordinator owns that wait. (If the repo has no verification pipeline, the coordinator will tell you to finish immediately on your green local build.)
> 8. **When the coordinator says `verified green, finish up`:** move the ticket to the `<last column>` column, record a **deep link** (the `main` commit URL, plus the pipeline run URL if there is one) in the Done section, and report **`done`**.
> 9. **When the coordinator says `block it`:** `ensure_tag <board> human-needed`, apply it (keep `claude`), append a `## 🤖 Claude — Blocked` section with the outstanding findings and what you tried, leave the ticket un-shipped, report **`blocked`**.
> Report exactly one word each turn — `ready-for-review`, `pushed`, `done`, or `blocked` — with a one-line reason. Never push before the coordinator says the review passed.

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
- The one genuinely long wait — verification after a push — is a **heartbeat stream** via `Monitor`, never a blocking call *of yours*. **Never run a pipeline watch (`gh run watch` or any equivalent) in your own foreground:** it blocks with no heartbeat, and a foreground command is capped at 10 minutes anyway — that combination is the original hang this design removed. A blocking watch is fine *inside* the waiter, where it is raced against the poll and the waiter is the thing emitting heartbeats. The rule is about who blocks, not about blocking.
- A wait that produces no output is indistinguishable from a wait that died. If you are waiting, something must be emitting.

## Never

- **Never report `done` before the change is pushed to `main` AND the verification probe has gone green.** A pushed branch, an open PR, or a green branch-CI run is NOT done.
- Never stop the loop to ask for deploy authorization — `/kando-loop` is the standing authorization to land tickets on `main` and deploy.
- Never push before the independent review passes. The reviewer is NEVER the implementer — always a fresh, separate agent.
- Never skip TDD when the change is testable; never accept a false "no testable surface" exemption.
- Never push a red build. Never mark `done` on a red or malformed verification. Never work a ticket assigned to a human. Never continue the loop after a red pipeline. Never lower the `human-needed` bar to skip hard work.
