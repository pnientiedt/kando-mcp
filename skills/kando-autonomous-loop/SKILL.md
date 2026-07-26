---
name: kando-autonomous-loop
description: Use when asked to autonomously work one or more Kando targets — boards, stories, or subtasks — to completion, e.g. via /kando-loop. Runs a coordinator loop that dispatches one worker subagent per ticket until nothing workable remains.
---

# Kando autonomous work loop

Work one or more Kando **targets** (board keys and/or `KEY-N` stories/subtasks) autonomously: a **coordinator loop** dispatches a **fresh worker subagent per ticket**, gates each ticket behind TDD and an **independent review**, and continues until nothing workable remains — across every target given, in order. Running `/kando-loop` authorizes spawning worker + reviewer subagents for this task.

**REQUIRED BACKGROUND:** the `kando` skill (the record-then-code gate) and the `test-driven-development` skill. Every worker follows both.

## Coordinator loop

You may be given **one OR MORE targets** (space-separated, e.g. `TSK-1 TSK-2 TSK-3` — board keys and/or `KEY-N` stories/subtasks, mixed). Process them **in order**. Keep your own context lean — you never implement or review; a worker implements, an independent reviewer judges. **Safety counters are cumulative across the whole run** — all targets share one budget.

**For each `target` in the list, in order, repeat until it is exhausted:**

1. Call `next_task(target)`. If it returns `{ "none": true }` → this target is **exhausted**: go to the **next target** (or, if it was the last, **stop — success**).
2. Enforce safety BEFORE dispatching (cumulative across all targets):
   - If `done + human-needed ≥ 25` → **stop (max-tasks)**.
   - If the last **3** results in a row were `human-needed` → **stop (circuit breaker)**.
3. Dispatch ONE worker subagent (Agent tool, general-purpose) with the **worker prompt** below for the ticket `KEY-N`. It works TDD-first, commits **locally (no push)**, and reports `ready-for-review` (or `blocked`).
4. **Independent review inner loop** (max **3** rounds) — while the worker reports `ready-for-review`:
   a. Dispatch a **fresh, independent reviewer subagent** (Agent tool, general-purpose) with the **reviewer prompt** below, giving it the ticket intent and the diff. It returns a BLOCKING list and an ADVISORY list.
   b. **No blocking findings** → SendMessage the worker: `review passed — ship it`. Go to step 5.
   c. **Blocking findings** → SendMessage the worker the findings. It fixes, recommits, and reports `ready-for-review` again. `round++`.
   d. If `round > 3` and still blocking → SendMessage the worker: `block it: <findings>`. It tags `human-needed` + writes a Blocked note; treat the result as `blocked`.
   - Advisory findings never block and never trigger a round; the worker may apply low-risk ones or note them in the Done section.
5. Read the worker's final report and **verify** it via `get_ticket` **and git**:
   - `done` → the ticket MUST be in the last column, carry the `claude` tag, and have a deep link in its `## 🤖 Claude — Done` section — **AND the change MUST be on `origin/main` with the Prod deploy green.** Verify the change is on main (`git fetch origin && git branch -r --contains <sha>` shows `origin/main`, or `gh run list --branch main` shows the green deploy for it). A `done` whose commit is only on a branch / in an open PR / merely green on branch-CI is **NOT done** — treat as a failure and **stop**.
   - `blocked` → the ticket MUST carry `claude` + `human-needed`. Count it toward the circuit breaker.
   - `deploy-failed` → **stop the whole loop immediately** — a broken deployment is an infra failure. Surface the failed-run link.
6. Loop back to step 1 for the **same target**.

Final summary: cumulative counts of done / human-needed / skipped, the stop reason, and — if a limit tripped mid-run — which target it stopped on.

## Worker prompt (one ticket; hands back to the coordinator at the review gate)

Dispatch a general-purpose subagent with this instruction (substitute the real `KEY-N`):

> You are a Kando worker. Work ONLY ticket **KEY-N**. Follow the `kando` skill's record-then-code gate AND the `test-driven-development` skill. Steps:
> 1. **Tag `claude` FIRST — before anything else.** `ensure_tag <board> claude`, then `update_ticket KEY-N` to apply its id (keep any tags the ticket already has), so the board shows it's being worked.
> 2. `get_ticket KEY-N` and `get_board` (for the bot's member `userSub`). Assign the ticket to the bot, move it to the in-progress column, and append a `## 🤖 Claude — Plan` section (preserve the original body). **If the body has a `## 📋 Specification` section, that is the authoritative spec — build to it (do not re-derive intent from the title).**
> 3. **TDD — write failing test(s) FIRST (RED).** Before any implementation, add test(s) covering the ticket's intended behavior using the repo's **existing** test suites/frameworks (match their patterns; do not invent a parallel harness). Run them and confirm they **fail for the right reason**. If a `## 📋 Specification` section exists, write these tests against its **Acceptance criteria**. *Exemption:* only if the change has genuinely no testable runtime surface (pure docs/config) — state that and why in the Plan section; the reviewer will verify it.
> 4. **Implement to green (GREEN).** Minimal code to make those tests pass; then run the full suite (and build, if any) and confirm it is green.
> 5. **Commit LOCALLY — do NOT push.** Append a `## 🤖 Claude — Done` section. `git commit`. Then **report `ready-for-review`** and STOP — do not push. The coordinator will have an independent reviewer look at your diff.
> 6. **When the coordinator sends review findings:** fix every BLOCKING one, keep the suite green, `git commit`, and report `ready-for-review` again. (Apply low-risk ADVISORY suggestions too, or note them in the Done section.)
> 7. **When the coordinator says `review passed — ship it`:** **DONE = the change is committed and pushed to `main` and the Prod deploy is green — nothing less.** Land the change on **`main`**: if you worked on a branch, merge it into `main` with `git merge --no-ff` (or commit directly on `main`), then **push `main`**. Running `/kando-loop` authorizes this — it is a standing pre-authorization to deploy; do NOT stop to ask, and do NOT leave the work on a branch or an open PR. Then find the Prod deploy run triggered by the push to main (`gh run list --branch main --limit 3`) and **watch it to completion** (`gh run watch <run-id>`): **green** → move the ticket to the last column, record a **deep link** (the `main` commit URL + the successful **Prod deploy run** URL) in the Done section, report **`done`**; **red** → report **`deploy-failed`** with the failed-run URL. (Only if this repo has NO push-to-`main` deploy pipeline is a green local build the gate, and the deep link is the `main` commit URL.)
> 8. **When the coordinator says `block it`:** `ensure_tag <board> human-needed`, apply it (keep `claude`), append a `## 🤖 Claude — Blocked` section with the outstanding findings and what you tried, leave the ticket un-shipped, report **`blocked`**.
> Report exactly one word each turn — `ready-for-review`, `done`, `blocked`, or `deploy-failed` — with a one-line reason. Never push before the coordinator says the review passed.

## Reviewer prompt (independent — never the implementer)

Dispatch a FRESH general-purpose subagent (it did NOT write this code) with:

> You are an INDEPENDENT code reviewer for Kando ticket **KEY-N**. You did not write this change; do not trust any implementer narrative. You are given the ticket **intent** (title/body/Plan) and the **diff** (`git diff` of the ticket's local commits). Review the diff directly and sort findings into two buckets and report both. (Do NOT try to invoke the `/code-review` skill — it can't be called by a subagent; apply code-review principles yourself.)
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

## Never

- **Never report `done` before the change is committed and pushed to `main` AND the Prod deploy is green.** A pushed branch, an open PR, or a green branch-CI run is NOT done — the deploy triggers on `main`.
- Never stop the loop to ask for deploy authorization — `/kando-loop` is the standing authorization to land tickets on `main` and deploy.
- Never push before the independent review passes. The reviewer is NEVER the implementer — always a fresh, separate agent.
- Never skip TDD when the change is testable; never accept a false "no testable surface" exemption.
- Never push a red build. Never mark `done` on a red deploy. Never work a ticket assigned to a human. Never continue the loop after a `deploy-failed`. Never lower the `human-needed` bar to skip hard work.
