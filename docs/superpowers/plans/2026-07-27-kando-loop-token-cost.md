# kando-loop Token Cost Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut the cost of a `/kando-loop` run by dispatching workers and reviewers on Sonnet instead of the inherited session model, and by fetching `get_board` once per board in the coordinator instead of once per ticket in the worker.

**Architecture:** Both changes are edits to a single prose document, `skills/kando-autonomous-loop/SKILL.md`, which is shipped to consumers by the `files` array in `package.json` and copied into `.claude/skills/` by `src/init.ts`. No TypeScript changes, no build step, no new files.

**Tech Stack:** Markdown. Verified with `npm test` (vitest) and `npm run typecheck` as regression gates only.

**Spec:** `docs/superpowers/specs/2026-07-27-kando-loop-token-cost-design.md`

## Global Constraints

- Only one file may be modified: `skills/kando-autonomous-loop/SKILL.md`. If you find yourself editing TypeScript, stop — you have misread the plan.
- **Do not change review-gate behavior.** Max 3 rounds, a fresh independent reviewer every round, full diff every round. The spec rejected narrowing these; see its "Rejected alternatives".
- **Do not override the coordinator's model.** Only the worker (step 3) and reviewer (step 4a) dispatches get an explicit model.
- The reviewer goes on `sonnet`, never `haiku`.
- Preserve the document's existing voice and formatting conventions: bold for imperatives, backticks for tool names and literals, `>` blockquote for the worker and reviewer prompts.

## TDD Exemption (read this before Task 1)

This plan has **no testable runtime surface**, and that claim is justified, not a shortcut:

- The deliverable is prose that another model reads at runtime. Its correctness is "does an agent behave differently", which this repo has no harness for.
- The existing suite treats skills as opaque: `src/init.test.ts:132` asserts only that `.claude/skills/kando/SKILL.md` *exists* after `init`. Nothing asserts on content.
- A test asserting `SKILL.md` contains the substring `model: sonnet` would restate the diff rather than exercise behavior — precisely the "trivial / gamed" test the reviewer prompt in this very file exists to reject.

Verification is therefore: the full suite still passes (proving `init` still copies the tree), plus the reading checks in Task 3.

---

### Task 1: Model tiering on worker and reviewer dispatch

**Files:**
- Modify: `skills/kando-autonomous-loop/SKILL.md:43` (coordinator step 3)
- Modify: `skills/kando-autonomous-loop/SKILL.md:45` (coordinator step 4a)
- Modify: `skills/kando-autonomous-loop/SKILL.md` (new section after the coordinator loop, before `## Worker prompt`)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: the `## Model tiering` section heading, which Task 2 does not touch. Task 2 edits a different region of the same file; apply Task 1 first to keep line numbers below stable.

- [ ] **Step 1: Add the model override to the worker dispatch**

In coordinator step 3, find this exact line:

```
3. Dispatch ONE worker subagent (Agent tool, general-purpose, **`run_in_background: false`**) with the **worker prompt** below for the ticket `KEY-N`. It works TDD-first, commits **locally (no push)**, and reports `ready-for-review` (or `blocked`).
```

Replace with:

```
3. Dispatch ONE worker subagent (Agent tool, general-purpose, **`model: sonnet`**, **`run_in_background: false`**) with the **worker prompt** below for the ticket `KEY-N`. It works TDD-first, commits **locally (no push)**, and reports `ready-for-review` (or `blocked`).
```

- [ ] **Step 2: Add the model override to the reviewer dispatch**

In coordinator step 4a, find this exact line:

```
   a. Dispatch a **fresh, independent reviewer subagent** (Agent tool, general-purpose, **`run_in_background: false`**) with the **reviewer prompt** below, giving it the ticket intent and the diff. It returns a BLOCKING list and an ADVISORY list.
```

Replace with:

```
   a. Dispatch a **fresh, independent reviewer subagent** (Agent tool, general-purpose, **`model: sonnet`**, **`run_in_background: false`**) with the **reviewer prompt** below, giving it the ticket intent and the diff. It returns a BLOCKING list and an ADVISORY list.
```

- [ ] **Step 3: Add the rationale section**

Insert this section immediately after the `Final summary:` line that ends the coordinator loop, and immediately before the `## Worker prompt (one ticket; hands back to the coordinator at the review gate)` heading:

```markdown
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
```

- [ ] **Step 4: Verify the edits read correctly**

Run: `grep -n "model: sonnet" skills/kando-autonomous-loop/SKILL.md`
Expected: exactly 3 matches — coordinator step 3, coordinator step 4a, and the tiering section.

Run: `grep -n "run_in_background: false" skills/kando-autonomous-loop/SKILL.md`
Expected: 3 matches (steps 3, 4a, and the "No silent waits" section) — confirming you added to the dispatch lines rather than replacing the existing flag.

- [ ] **Step 5: Commit**

```bash
git add skills/kando-autonomous-loop/SKILL.md
git commit -m "perf(loop): dispatch workers and reviewers on sonnet

A run boots 50-100 subagents, each inheriting the session model. Worker
and reviewer both execute against written criteria, so they move to
sonnet; the coordinator keeps the session model for the judgment calls."
```

---

### Task 2: Hoist `get_board` from the worker to the coordinator

**Files:**
- Modify: `skills/kando-autonomous-loop/SKILL.md` (coordinator preamble, after the verification-command block)
- Modify: `skills/kando-autonomous-loop/SKILL.md` (coordinator step 3, extending Task 1's edit)
- Modify: `skills/kando-autonomous-loop/SKILL.md` (worker prompt steps 2 and 8)

**Interfaces:**
- Consumes: Task 1's edited step 3 line. The Step 2 find-string below includes Task 1's `**`model: sonnet`**` insertion — if it does not match, Task 1 was not applied.
- Produces: the placeholders `<userSub>`, `<in-progress column>`, and `<last column>`, which the coordinator substitutes at dispatch. No later task depends on these.

- [ ] **Step 1: Add the per-board lookup to the coordinator preamble**

Find this exact line (it ends the verification-command block):

```
If you can compose neither, skip the wait entirely and fall back to the green-local-build gate described in the worker prompt.
```

Insert immediately after it, before the `**For each `target` in the list, in order, repeat until it is exhausted:**` line:

```markdown
**On each board's first ticket, call `get_board` once — then never again for that
board.** The worker does not call it. Cache three things per board: the bot member's
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
```

- [ ] **Step 2: Tell step 3 to substitute the cached values**

Find this exact line (it carries Task 1's edit):

```
3. Dispatch ONE worker subagent (Agent tool, general-purpose, **`model: sonnet`**, **`run_in_background: false`**) with the **worker prompt** below for the ticket `KEY-N`. It works TDD-first, commits **locally (no push)**, and reports `ready-for-review` (or `blocked`).
```

Replace with:

```
3. Dispatch ONE worker subagent (Agent tool, general-purpose, **`model: sonnet`**, **`run_in_background: false`**) with the **worker prompt** below for the ticket `KEY-N`, substituting this board's cached `<userSub>`, `<in-progress column>`, and `<last column>` into it. It works TDD-first, commits **locally (no push)**, and reports `ready-for-review` (or `blocked`).
```

- [ ] **Step 3: Remove `get_board` from worker step 2**

Find this exact line in the worker prompt:

```
> 2. `get_ticket KEY-N` and `get_board` (for the bot's member `userSub`). Assign the ticket to the bot, move it to the in-progress column, and append a `## 🤖 Claude — Plan` section (preserve the original body). **If the body has a `## 📋 Specification` section, that is the authoritative spec — build to it (do not re-derive intent from the title).**
```

Replace with:

```
> 2. `get_ticket KEY-N`. Assign the ticket to `<userSub>`, move it to the `<in-progress column>` column, and append a `## 🤖 Claude — Plan` section (preserve the original body). **Do NOT call `get_board`** — the coordinator has already given you every board value you need. **If the body has a `## 📋 Specification` section, that is the authoritative spec — build to it (do not re-derive intent from the title).**
```

- [ ] **Step 4: Substitute the last column in worker step 8**

Find this exact line in the worker prompt:

```
> 8. **When the coordinator says `verified green, finish up`:** move the ticket to the last column, record a **deep link** (the `main` commit URL, plus the pipeline run URL if there is one) in the Done section, and report **`done`**.
```

Replace with:

```
> 8. **When the coordinator says `verified green, finish up`:** move the ticket to the `<last column>` column, record a **deep link** (the `main` commit URL, plus the pipeline run URL if there is one) in the Done section, and report **`done`**.
```

- [ ] **Step 5: Verify the worker no longer reaches for the board**

Run: `grep -n "get_board" skills/kando-autonomous-loop/SKILL.md`
Expected: 3 matches — two in the coordinator preamble (the lookup instruction and the re-fetch fallback), and exactly one `>`-prefixed line, which must be worker step 2's **prohibition** (`**Do NOT call `get_board`**`). If any `>`-prefixed line still *instructs* a fetch, Step 3 was not applied.

Run: `grep -c "userSub" skills/kando-autonomous-loop/SKILL.md`
Expected: `4` — the preamble instruction, the run-header example, coordinator step 3's substitution list, and worker step 2.

- [ ] **Step 6: Commit**

```bash
git add skills/kando-autonomous-loop/SKILL.md
git commit -m "perf(loop): fetch the board once per board, not once per ticket

Worker step 2 called get_board solely for the bot's userSub, paying a
full board payload on every ticket. The coordinator now caches userSub
and the column names per board behind a per-turn run header and
substitutes them at dispatch."
```

---

### Task 3: Regression gate and read-through

**Files:**
- Modify: none. This task only verifies.

**Interfaces:**
- Consumes: the completed edits from Tasks 1 and 2.
- Produces: nothing.

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: PASS. Nothing should have changed — this proves `src/init.ts` still copies the skills tree and that no TypeScript was touched. If any test fails, you edited something outside `SKILL.md`.

- [ ] **Step 2: Run the typecheck**

Run: `npm run typecheck`
Expected: clean exit, no output.

- [ ] **Step 3: Confirm the diff is one file**

Run: `git diff --stat main...HEAD -- . ':!docs'`
Expected: exactly one file listed, `skills/kando-autonomous-loop/SKILL.md`.

- [ ] **Step 4: Read the changed document end to end**

Read `skills/kando-autonomous-loop/SKILL.md` in full and confirm all four:

1. The coordinator loop still reads as a coherent sequence — the inserted preamble block sits between the verification-command block and the `For each target` line, not inside either.
2. The `<userSub>`, `<in-progress column>`, and `<last column>` placeholders appear in exactly two places: the worker prompt blockquote (steps 2 and 8), where they are substituted, and coordinator step 3, which names them as the things to substitute. Nowhere else.
3. The review inner loop (step 4) is **byte-identical to `main` apart from the `model: sonnet` insertion in 4a**. Confirm with:

   Run: `git diff main...HEAD -- skills/kando-autonomous-loop/SKILL.md | grep -E "^[-+].*(round\+\+|round > 3|max \*\*3\*\*|rounds\))"`
   Expected: no output.

   Do **not** grep for the bare word `round` — `run_in_back`**`ground`** contains it, so the tiering edits from Task 1 match and the check reports a failure that isn't there.

4. The `## Never` section is unchanged.

- [ ] **Step 5: Commit any read-through fixes**

Only if Step 4 surfaced a problem:

```bash
git add skills/kando-autonomous-loop/SKILL.md
git commit -m "docs(loop): fix wording surfaced by plan read-through"
```

If Step 4 was clean, skip this step — do not create an empty commit.

---

## Out of scope

Do not attempt these; the spec explicitly rejected or deferred them:

- Trimming `~/git/kando/CLAUDE.md`. Deferred, different repo.
- Narrowing what review rounds 2–3 see. Rejected — it would let a change ship without any single reviewer having approved it whole.
- Reducing max review rounds from 3 to 2. Rejected.
- Skipping the reviewer for docs/config-only diffs. Rejected.
- Putting the reviewer on `haiku`. Rejected.
