# kando-loop Batched Deploys Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/kando-loop` ship a completed story rather than every subtask — workers land on a per-run loop branch, and the coordinator merges to `main` and runs the full verification once per batch.

**Architecture:** One server change makes batching possible (`selectNextTask` must not re-serve a finished-but-unshipped ticket, which it detects via a new `pending-ship` tag). Everything else is prose: the coordinator skill gains branch setup, a flush procedure, and a red-flush fixer path; the worker prompt loses its authority to push `main`.

**Tech Stack:** TypeScript (ESM, NodeNext), Vitest, Zod, MCP SDK. Skills, agents and commands are Markdown shipped in this repo and copied into target repos by `kando-mcp init`.

**Spec:** `docs/superpowers/specs/2026-07-27-kando-loop-batched-deploys-design.md`

## Global Constraints

- The tag name is exactly **`pending-ship`**, matched **case-insensitively**, exactly as `human-needed` is matched today (`src/tools/loop.ts:99`).
- The loop branch is named **`kando-loop/<run-id>`** where `<run-id>` is a `YYYYMMDD-HHMMSS` timestamp.
- Fixer attempts are bounded at **2 per red flush**; the counter resets on green.
- Existing safety numbers are unchanged: `max-tasks = 25`, circuit breaker at **3** consecutive `human-needed`, review inner loop at **3** rounds.
- Fixer attempts count toward **none** of those budgets.
- `npm test` runs offline and must stay green. Do not run `src/live.e2e.test.ts`.
- Every task ends with `npm run typecheck && npm test` green before its commit.

---

### Task 1: `selectNextTask` skips `pending-ship` tickets

This is the only server change, and the whole design rests on it. Without it, a ticket that has been implemented, reviewed and parked on the loop branch is still in the in-progress column and still assigned to the bot, so `next_task` hands the coordinator **the same ticket forever**.

The change mirrors the existing `human-needed` exclusion exactly: resolve the tag id from `bc.tags` by case-insensitive name, then reject any unit carrying that id.

**Files:**
- Modify: `src/tools/loop.ts:99` (tag id resolution) and `src/tools/loop.ts:113` (the filter)
- Test: `src/tools/loop.test.ts` (the `describe('selectNextTask', ...)` block)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: the behaviour Task 3's skill prose depends on — a ticket tagged `pending-ship` is never returned by `next_task`. No signature changes: `selectNextTask(bc, scope, botSub)` keeps its shape.

- [ ] **Step 1: Write the failing tests**

Add to `src/tools/loop.test.ts`, inside `describe('selectNextTask', ...)`. The shared `board` fixture already declares `tags: [{ id: 't-hn', name: 'human-needed' }]` and a standalone story `s1` (`TSK-1`) that is the normal pick — these tests extend that fixture rather than building a new one.

```ts
  it('skips a pending-ship unit — work parked on the loop branch is not re-served', () => {
    // TSK-1 is the normal pick. Tagged pending-ship it is finished-but-unshipped:
    // still in an in-progress column, still assigned to the bot, and NOT workable.
    const held = {
      ...board,
      tags: [...board.tags, { id: 't-ps', name: 'pending-ship' }],
      stories: [{ ...board.stories[0], tags: ['t-ps'] }],
    };
    expect(selectNextTask(held, { kind: 'board' }, 'bot')).toBeNull();
  });

  it('matches the pending-ship tag case-insensitively, like human-needed', () => {
    const held = {
      ...board,
      tags: [...board.tags, { id: 't-ps', name: 'Pending-Ship' }],
      stories: [{ ...board.stories[0], tags: ['t-ps'] }],
    };
    expect(selectNextTask(held, { kind: 'board' }, 'bot')).toBeNull();
  });

  it('serves the ticket again once pending-ship is cleared', () => {
    const released = {
      ...board,
      tags: [...board.tags, { id: 't-ps', name: 'pending-ship' }],
      stories: [{ ...board.stories[0], tags: [] }],
    };
    expect(selectNextTask(released, { kind: 'board' }, 'bot')?.ticket).toBe('TSK-1');
  });

  it('is unaffected on a board that has no pending-ship tag', () => {
    // The tag is optional: a board that never defined it behaves exactly as before.
    expect(selectNextTask(board, { kind: 'board' }, 'bot')?.ticket).toBe('TSK-1');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/tools/loop.test.ts -t 'pending-ship'`

Expected: the first two FAIL (`selectNextTask` still returns `TSK-1`, so `toBeNull()` fails). The third and fourth pass already — they are the regression guards that must keep passing.

- [ ] **Step 3: Write the minimal implementation**

In `src/tools/loop.ts`, next to the existing `hnId` line (currently line 99):

```ts
  const hnId = (bc.tags ?? []).find((t: any) => (t.name ?? '').toLowerCase() === 'human-needed')?.id;
  const psId = (bc.tags ?? []).find((t: any) => (t.name ?? '').toLowerCase() === 'pending-ship')?.id;
```

And in the `.find()` predicate, immediately after the `human-needed` line (currently line 113):

```ts
    if (hnId && (item.tags ?? []).includes(hnId)) return false; // human-needed
    if (psId && (item.tags ?? []).includes(psId)) return false; // shipped-pending: on the loop branch, awaiting a flush
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/tools/loop.test.ts`
Expected: PASS, whole file.

- [ ] **Step 5: Document the exclusion where the ordering is explained**

The block comment above `selectNextTask` (`src/tools/loop.ts:35-58`) explains the tiering and why Done is load-bearing. Add a short paragraph to it stating that `pending-ship` marks a ticket the loop has completed and parked on its branch awaiting a flush, that it is excluded from selection for exactly that reason, and that the coordinator clears it when the batch ships green. A future reader must not be able to mistake it for a user-facing tag.

- [ ] **Step 6: Verify the whole suite and typecheck**

Run: `npm run typecheck && npm test`
Expected: both green.

- [ ] **Step 7: Commit**

```bash
git add src/tools/loop.ts src/tools/loop.test.ts
git commit -m "feat(next_task): never serve a pending-ship ticket

Batched deploys park a reviewed ticket on the loop branch until its batch
flushes. Such a ticket is still in an in-progress column and still assigned
to the bot, so without this exclusion next_task would serve it forever."
```

---

### Task 2: refresh the CLAUDE.md deploy-authorization block

`LOOP_AUTH_BLOCK` (`src/init.ts:15`) tells target repos that the loop's **subagents** "commit, push to `main`, and trigger the deploy". After Task 3 that is false: workers push only the loop branch, and the coordinator owns `main`.

Worse, `ensureLoopAuthorization` (`src/init.ts:23`) returns early when the marker is present, so every repo that has already run `init` would keep the stale wording forever, however many times `init` is re-run. It must **replace** a stale block, not skip it.

**Files:**
- Modify: `src/init.ts:14-27`
- Test: `src/init.test.ts` (the `describe('ensureLoopAuthorization', ...)` block)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `ensureLoopAuthorization(text: string): string` — unchanged signature, now replacing a stale block in place. `LOOP_AUTH_MARKER` keeps its exact current value `'## Kando autonomous loop — deploy authorization'`; changing it would orphan every installed block.

- [ ] **Step 1: Write the failing tests**

Add to `src/init.test.ts` inside `describe('ensureLoopAuthorization', ...)`. Keep the three existing tests — the idempotence one still holds, because replacing a current block reproduces it byte for byte.

```ts
  it('replaces a stale block rather than leaving it', () => {
    // A repo installed before batched deploys carries the old wording. Re-running
    // init must refresh it, or the repo authorizes something the loop no longer does.
    const stale =
      '# P\n\n## Kando autonomous loop — deploy authorization\n\nOld wording: subagents push to `main`.\n';
    const out = ensureLoopAuthorization(stale);
    expect(out).toContain('# P');
    expect(out).not.toContain('Old wording');
    expect(out).toContain('loop branch');
    expect((out.match(/## Kando autonomous loop — deploy authorization/g) ?? []).length).toBe(1);
  });

  it('preserves sections that follow the block when replacing', () => {
    const stale =
      '# P\n\n## Kando autonomous loop — deploy authorization\n\nOld wording.\n\n## My own rules\n\nKeep me.\n';
    const out = ensureLoopAuthorization(stale);
    expect(out).toContain('## My own rules');
    expect(out).toContain('Keep me.');
    expect(out).not.toContain('Old wording');
  });

  it('says the coordinator owns main and workers stay on the branch', () => {
    const out = ensureLoopAuthorization('');
    expect(out).toMatch(/loop branch/);
    expect(out).toMatch(/coordinator/);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/init.test.ts -t 'ensureLoopAuthorization'`
Expected: the three new tests FAIL — the first two because the current implementation returns the input untouched when the marker is present, the third because the block text does not yet mention a branch or the coordinator.

- [ ] **Step 3: Write the new block text and the replacing implementation**

Replace `src/init.ts:15-27` with:

```ts
const LOOP_AUTH_BLOCK = `${LOOP_AUTH_MARKER}

The \`/kando-loop\` command runs an autonomous work loop that **spawns worker and reviewer subagents** (the Agent/Task tool) and lets them **commit and push to a \`kando-loop/*\` branch**, and lets the loop **merge that branch to \`main\` and trigger the deploy** once a batch of tickets is worth shipping — that is its intended, sanctioned flow. The coordinator, not a worker, is what touches \`main\`. Do not gate the loop's subagent dispatch, its branch pushes, or its deploys behind asking. (Added by the Kando MCP installer so /kando-loop runs under auto mode; delete this section to withdraw the authorization.)`;

/**
 * Ensure a repo's CLAUDE.md carries the CURRENT loop deploy-authorization section.
 *
 * Replaces a stale block rather than skipping it: the marker is stable across
 * versions, so a repo installed by an older `init` would otherwise keep wording that
 * authorizes something the loop no longer does — and re-running `init`, the obvious
 * fix, would silently do nothing. Idempotent: re-running on a current block
 * reproduces it byte for byte.
 */
export function ensureLoopAuthorization(text: string): string {
  const src = text ?? '';
  const at = src.indexOf(LOOP_AUTH_MARKER);
  if (at === -1) {
    const base = src.trimEnd();
    return (base ? base + '\n\n' : '') + LOOP_AUTH_BLOCK + '\n';
  }
  // The block runs from the marker to the next top-level section, or to the end.
  const rest = src.slice(at + LOOP_AUTH_MARKER.length);
  const nextHeading = rest.search(/\n## /);
  const before = src.slice(0, at).trimEnd();
  const after = nextHeading === -1 ? '' : rest.slice(nextHeading + 1);
  return (before ? before + '\n\n' : '') + LOOP_AUTH_BLOCK + '\n' + (after ? '\n' + after : '');
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/init.test.ts`
Expected: PASS, whole file — including the pre-existing `is idempotent` test.

- [ ] **Step 5: Refresh this repo's own CLAUDE.md**

This repo carries the block too (`CLAUDE.md`). Rewrite its authorization section to the new wording so the repo does not contradict what it ships. Copy the prose from `LOOP_AUTH_BLOCK` verbatim (unescaping the template-literal backslashes).

- [ ] **Step 6: Verify the whole suite and typecheck**

Run: `npm run typecheck && npm test`
Expected: both green.

- [ ] **Step 7: Commit**

```bash
git add src/init.ts src/init.test.ts CLAUDE.md
git commit -m "fix(init): refresh a stale deploy-authorization block

Workers now push a kando-loop/* branch and only the coordinator touches
main. The marker-keyed early return meant an already-installed repo could
never learn that, not even by re-running init."
```

---

### Task 3: teach the coordinator to batch and flush

The behaviour change. `skills/kando-autonomous-loop/SKILL.md` currently pushes `main` and waits for the full pipeline **per ticket** (step 5, and worker prompt steps 7–8). It must instead park each reviewed ticket on a branch and verify **per batch**.

Read the spec's sections 1–6 before editing; this task implements them.

**Files:**
- Modify: `skills/kando-autonomous-loop/SKILL.md`
- Test: none automated — see "Verification" below. The repo does not test skill prose, deliberately.

**Interfaces:**
- Consumes: Task 1's `pending-ship` exclusion. The prose must not describe any other mechanism for holding a finished ticket.
- Produces: the worker contract Task 4 restates in `agents/kando-worker.md` — a worker pushes `kando-loop/<run-id>` and never `main`, and its terminal reports are exactly `ready-for-review`, `pushed`, `blocked`.

- [ ] **Step 1: Add run-start branch setup**

After the verification-command composition section (which stays as it is — the same `--watch` / `--probe` commands are now armed once per flush instead of once per ticket), add a short section establishing:

- a dirty working tree at run start is a **hard stop**, so uncommitted work is never swept into a batch;
- the coordinator brings `main` up to date, cuts `kando-loop/<run-id>` (`<run-id>` = `YYYYMMDD-HHMMSS`), and checks it out;
- one branch serves the whole run, including a multi-target run spanning several boards;
- the branch name goes in the run header alongside the per-board cache, because the coordinator ends its turn during flush waits and must recover the name after a heartbeat re-invocation.

- [ ] **Step 2: Rewrite the numbered loop for batching**

Change the numbered steps so that:

- **step 3** (dispatch) is unchanged apart from noting that the base sha is recorded on the branch;
- **step 4** (review inner loop) is unchanged;
- **step 4b** — on review pass, the coordinator SendMessages the worker `review passed — push the branch`; the worker pushes `kando-loop/<run-id>` and reports `pushed`;
- **a new step 5** replaces today's per-ticket verification wait: the coordinator applies `pending-ship` to the ticket (via `ensure_tag` + `update_ticket`, keeping existing tags) and leaves it in the in-progress column. **No pipeline wait happens here.** Add the ticket to the in-memory batch list, and state that the tag — not that list — is the durable record;
- **step 6** verifies the worker's report via `get_ticket`: `pushed` → the ticket carries `claude` + `pending-ship`, is in the in-progress column, and has `Plan` and `Done` sections. `blocked` → `claude` + `human-needed`, counted toward the circuit breaker;
- **step 7** decides whether to flush before looping: call `next_task` for the target and compare its `storyId` to the finished ticket's. Different `storyId`, or `{none: true}` → **the story completed → flush now**. Otherwise the coordinator may still flush on judgement — a coherent, deployable unit — with the standing bias that chores, flaky-test fixes, docs and config never earn a deploy of their own. Note explicitly that `next_task` returns `storyId` only for subtasks, so a run of standalone stories has no story boundary and relies on judgement plus the exit flush.

- [ ] **Step 3: Write the flush section**

A new top-level section, written as a procedure the coordinator follows verbatim, covering spec section 4:

- merge (`git checkout main && git pull --ff-only`, `git merge --no-ff kando-loop/<run-id>` with a message naming every ticket in the batch, `git push origin main`), recording the merge sha;
- arm the existing waiter against the merge sha — `Monitor`, `persistent: true`, `node .claude/hooks/kando-verify-wait.mjs` with the composed `--watch` / `--probe` — and end the turn. State that this mechanism is unchanged and only its frequency drops;
- **exit 0** → for each batched ticket the coordinator itself removes `pending-ship`, moves it to the last column, and writes the deep link (the `main` commit URL plus the pipeline run URL) into `## 🤖 Claude — Done`. Then `git checkout kando-loop/<run-id> && git merge --ff-only main`, clear the batch list, continue. Say why the coordinator does these writes: the batch's workers finished turns ago, and it already holds `update_ticket` and `move_ticket`;
- **exit 3** → stop the whole loop, exactly as today;
- **repos with no composable verification** → the merge lands, the board writes happen immediately, and the gate is the workers' green local builds.

Also state the three flush triggers in one place (story boundary, coordinator judgement, run exit) and that **the loop blocks on a flush** — no ticket starts until the verdict lands.

- [ ] **Step 4: Write the red-flush path**

Covering spec section 5:

- **exit 1** → `main` and production are broken. The coordinator says so prominently, not in a status line;
- dispatch a **`kando-worker`** (`model: sonnet`, `run_in_background: false`) on a **synthetic brief** — no board ticket — carrying the failing run's output and URL, the merge sha, the batch's ticket keys, and the diff range to read. The fixer works on the loop branch, which already holds the whole batch (`main` differs only by the merge commit), keeps TDD where the failure has a testable surface, commits, pushes the branch, reports `ready-for-review`;
- a **fresh `kando-reviewer`** judges the fix on its own diff range, same 3-round inner loop;
- on review pass, **re-flush**;
- **bounded at 2 fixer attempts per red flush, resetting on green**. On exhaustion: `git revert -m 1 <merge-sha>` and push, restoring `main` and production; write `## 🤖 Claude — Blocked` on every batched ticket naming the red run and what both fixers tried; stop the loop reporting the merge sha, run URL, revert sha, batch tickets and fixer attempts;
- fixer attempts count toward **neither** the `done` / `human-needed` counters, the circuit breaker, nor `max-tasks`;
- state the manual-recovery point plainly: after an exhausted red flush the batch keeps `pending-ship`, so no later run re-selects those tickets, and a human resolves them from the Blocked notes.

- [ ] **Step 5: Add the exit flush**

Wherever the loop terminates — target exhausted, `max-tasks`, circuit breaker, or a `stop` from any other branch except a red-flush exhaustion (which has already reverted) — the coordinator flushes whatever is on the branch first. Nothing is ever left silently unshipped. The final summary gains the branch name, the batches shipped, and any tickets left `pending-ship`.

- [ ] **Step 6: Rewrite worker prompt steps 7 and 8**

Replace step 7 with this text, and **delete step 8 entirely** (the coordinator now does those board writes), renumbering the `block it` step:

> 7. **When the coordinator says `review passed — push the branch`:** push the loop branch `kando-loop/<run-id>` — the branch you are already on. **Never push `main`, never merge into `main`, and never open a PR.** Running `/kando-loop` authorizes the push; do NOT stop to ask. Then report **`pushed`** with the commit sha and STOP. The coordinator decides when this ticket's batch ships and owns every pipeline wait — do not watch one yourself, and do not move the ticket to the last column.

Renumber the remaining step and update the final line of the prompt so the terminal reports read: `ready-for-review`, `pushed`, or `blocked` — `done` is no longer a worker report.

- [ ] **Step 7: Update the "Never" and "No silent waits" sections**

- "Never report `done` before the change is pushed to `main` AND the verification probe has gone green" — keep the substance, restate for the flush: `done` is set by the **coordinator**, only after the batch's merge commit is on `main` and its verification has gone green. A ticket on the loop branch is not done.
- "Never stop the loop to ask for deploy authorization" — extend to cover the branch push and the flush merge.
- Add: **never let a worker push `main`**, and **never leave a batch on the branch at exit**.
- In "No silent waits", the long wait is now the **flush** verification rather than the per-ticket one. Update the wording; the rule (heartbeat stream, never a blocking watch in the coordinator's foreground) is unchanged.

- [ ] **Step 8: Verification — read the result end to end**

Automated tests cannot check prose. Read the edited `SKILL.md` start to finish and confirm each of these, fixing any that fail:

- no instruction anywhere still tells a worker to push or merge `main`;
- no instruction still waits for a pipeline per ticket;
- `pending-ship` is applied exactly once (coordinator, on review pass) and cleared in exactly two places (green flush, and never on exhaustion);
- every path that ends the run flushes first, except red-flush exhaustion, which reverts;
- the fixer bound (2) and the review bound (3) are never confused with one another;
- the worker prompt's reported words and the coordinator's expectations of them match exactly.

- [ ] **Step 9: Commit**

```bash
git add skills/kando-autonomous-loop/SKILL.md
git commit -m "feat(loop): batch tickets on a branch, flush a story at a time

Workers park reviewed tickets on kando-loop/<run-id> under a pending-ship
tag; the coordinator merges to main and runs the full verification once per
batch, fixes forward twice on red, then reverts."
```

---

### Task 4: align the worker agent definition and the README

Two documents still describe the old contract. `agents/kando-worker.md:12-15` says the loop "runs unattended with standing authorization to push"; `README.md:66-70` describes per-push verification with no mention of batching.

**Files:**
- Modify: `agents/kando-worker.md`
- Modify: `README.md:64-70` (the "Skills & commands" section)
- Test: none automated.

**Interfaces:**
- Consumes: Task 3's worker contract — a worker pushes `kando-loop/<run-id>` and never `main`; terminal reports are `ready-for-review`, `pushed`, `blocked`.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Scope the worker agent's push authority**

In `agents/kando-worker.md`, amend the standing-authorization paragraph so it says the worker's push authority is limited to the run's `kando-loop/*` branch, that `main` belongs to the coordinator, and that this is why nothing destructive is in reach. Keep the existing tool-restriction rationale intact.

- [ ] **Step 2: Describe batching in the README**

In the "Skills & commands" section, state that `/kando-loop` works tickets onto a per-run `kando-loop/*` branch and ships a **batch** — normally a completed story — to `main`, running the repo's full verification once per batch instead of once per ticket. Keep the existing paragraph about composed verification commands and the background waiter; it is still accurate, just less frequent. Mention that a red batch is fixed forward twice and then reverted.

- [ ] **Step 3: Check the tool list is still accurate**

`README.md:56` lists the Loop tools as `next_task`, `ensure_tag`. Both are still correct, and `pending-ship` needs no new tool — `ensure_tag` creates it and `update_ticket` applies it. Confirm no other README claim contradicts the new flow (in particular the sentence about how `/kando-loop` verifies each *pushed change*).

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npm test`
Expected: both green (no code changed; this confirms nothing was broken by a stray edit).

- [ ] **Step 5: Commit**

```bash
git add agents/kando-worker.md README.md
git commit -m "docs: workers push the loop branch, the coordinator ships batches"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| 1. One loop branch per run | Task 3, steps 1–2 |
| 2. The `pending-ship` hold state | Task 1 (mechanism), Task 3 step 2 (use) |
| 3. Flush triggers | Task 3, steps 2 (story boundary, judgement), 5 (exit) |
| 4. The flush procedure | Task 3, step 3 |
| 5. The red path | Task 3, step 4 |
| 6. What "done" means now | Task 3, steps 3 and 7; Task 4 step 1 |
| Changes by file → `src/tools/loop.ts` + test | Task 1 |
| Changes by file → `src/init.ts` + test | Task 2 |
| Changes by file → `SKILL.md` | Task 3 |
| Changes by file → `kando-worker.md`, `README.md` | Task 4 |

No gaps.

**Type consistency:** `selectNextTask(bc, scope, botSub)` and `ensureLoopAuthorization(text)` keep their existing signatures; `LOOP_AUTH_MARKER` keeps its exact current value. The new local `psId` mirrors `hnId`. The worker's reported words (`ready-for-review`, `pushed`, `blocked`) are used identically in Tasks 3 and 4, and `done` is removed from the worker's vocabulary in both.

**Sequencing note:** Task 1 is inert until Task 3 uses it, so the two may be committed independently. Task 2 is independent of both.
