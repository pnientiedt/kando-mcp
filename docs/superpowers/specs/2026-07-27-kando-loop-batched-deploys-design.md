# kando-loop batched deploys: ship a story, not a subtask

**Date:** 2026-07-27
**Status:** approved, ready for planning

## Problem

Every ticket a `/kando-loop` run completes costs one push to `main`, one production
deploy, and one full end-to-end suite run. The loop blocks on that verification before
it starts the next ticket, so a story with ten subtasks pays for ten deploys and ten
e2e runs to ship one coherent change.

Two things are wrong with that, and they are separate:

- **Wall clock.** The e2e suite dominates the run. Ten sequential full-suite waits is
  the single largest cost of a loop run, and nine of them told you nothing you did not
  already know from the tenth.
- **Deploy granularity.** A subtask is not a unit of production change. Shipping a
  flaky-test fix or the third of ten subtasks to production is not a deploy anybody
  asked for; it is an artifact of the loop's ticket-at-a-time contract leaking into
  the release process.

The fix is to decouple the two: keep working ticket-at-a-time, ship batch-at-a-time.

## Goals

- Ship on units that make sense as production changes — typically a completed story.
- Cut full-suite waits from one per ticket to one per shipped batch.
- Keep every existing quality gate intact: TDD, independent review, and a real
  verification before anything counts as done.
- Keep completed work durable and visible if the loop dies mid-run.
- Keep the change inside the reusable plugin skill (plus one small server change), so
  every repo the loop is pointed at benefits.

## Non-goals

- **Changing any target repo's CI.** Splitting an e2e suite into smoke and full,
  sharding it, or moving it off the deploy path is worth doing, but it is per-repo
  work and out of scope here.
- **Working tickets during a flush.** The coordinator stays strictly sequential and
  blocks on the flush verdict. Overlapping them hides more wall clock but leaves a
  fixer patching a batch the branch has already moved past.
- **A per-ticket cheap CI gate.** Considered and rejected — see "Rejected
  alternatives".
- **Concurrency of any other kind.** One worker at a time, as today.

## Design

### 1. One loop branch per run

At run start, before the first ticket, the coordinator cuts
`kando-loop/<run-id>` — where `<run-id>` is a `YYYYMMDD-HHMMSS` timestamp — from an
up-to-date `main`, and checks it out. Workers commit and push **that branch**. They
never push `main`.

A dirty working tree at run start is a hard stop — the loop refuses to start rather
than sweeping uncommitted work into a batch it will ship.

Only the coordinator touches `main`, and only during a flush. This is the single
biggest contract change to the worker prompt, whose step 7 currently reads "land the
change on `main` … then push `main`".

The branch is pushed on every ticket, so completed work is durable: if the loop, the
session, or the machine dies, the work is on the remote and the run summary names the
branch.

One branch serves the whole run, including a multi-target run that spans several
boards. After a green flush the branch is fast-forwarded to `main` and reused.

### 2. The `pending-ship` hold state

A ticket whose review has passed and whose commit is on the branch is **not done** —
it has not shipped. It stays in the in-progress column until its batch flushes green.

That creates a selection problem. `selectNextTask` (`src/tools/loop.ts`) excludes a
ticket only when it is in the last column, snoozed, tagged `human-needed`, or assigned
to a human. A finished-but-unshipped ticket is none of those, so `next_task` would
return **the same ticket forever** and the loop would rework it until a cap tripped.

Batching therefore cannot be done in skill text alone. `selectNextTask` gains one more
exclusion: a ticket tagged **`pending-ship`** is not workable. The coordinator applies
the tag when a ticket's review passes and removes it when the batch ships green.

The tag is also the durable record of the hold. If the loop dies, the board itself
shows exactly which tickets are sitting on the branch unshipped — no in-context set to
lose.

**Rejected:** snoozing held tickets via `visibleAt`, which `update_ticket` already
exposes and which the existing filter already honours, requiring no server change. A
snoozed ticket reads to a human as "not yet relevant"; the state we are recording is
"finished, waiting to ship". The tag says what it means.

### 3. Flush triggers

A **flush** is: merge the loop branch into `main`, push, deploy, run the full
verification. Three things trigger one.

**A story completes.** `next_task` already returns `storyId` for a subtask, and its
ordering drains one container story before starting another. So the coordinator
compares the `storyId` of the task it just finished against the next one: if it
differs, or `next_task` returns `{none: true}`, that story is complete — flush before
dispatching the next worker. This costs no extra board calls.

**The coordinator judges it worth shipping.** Beyond the mechanical boundary, the
coordinator may flush when the accumulated work reads as a coherent, deployable unit.
The standing bias: chores, flaky-test fixes, docs and config never earn a deploy of
their own.

**The run is about to exit.** Whatever the reason — target exhausted, `max-tasks`,
circuit breaker — the coordinator flushes whatever is on the branch before it exits.
Nothing is ever left silently unshipped.

The loop **blocks** on a flush: no ticket starts until the verdict lands.

### 4. The flush procedure

The coordinator, never a worker:

1. `git checkout main && git pull --ff-only`, then
   `git merge --no-ff kando-loop/<run-id>` with a message naming every ticket in the
   batch, then `git push origin main`. Record the **merge sha**.
2. Arm the existing waiter — `Monitor`, `persistent: true`,
   `node .claude/hooks/kando-verify-wait.mjs` with the composed `--watch` / `--probe`
   against the merge sha — and end the turn. Heartbeats re-invoke. This mechanism is
   unchanged; only its frequency drops, from once per ticket to once per batch.
3. **Waiter exits 0 (green)** → for each ticket in the batch the coordinator removes
   `pending-ship`, moves it to the last column, and writes the deep link (the `main`
   commit URL plus the pipeline run URL) into its `## 🤖 Claude — Done` section. Then
   `git checkout kando-loop/<run-id> && git merge --ff-only main` to carry the branch
   forward, and the loop continues.
4. **Waiter exits 3** → stop the whole loop, unchanged from today. A malformed probe or
   a watch that went unavailable never means green.

The coordinator owns the board writes at step 3 because it is the only party still
alive at flush time — the batch's workers finished turns ago. It already holds
`update_ticket` and `move_ticket`.

**Repos with no composable verification** skip step 2 entirely: the merge lands, the
board writes happen immediately, and the gate is the workers' green local builds —
the same fallback the loop has today.

### 5. The red path: fix forward, then revert

**Waiter exits 1.** `main` and production are broken. The coordinator says so
prominently in its output rather than burying it in a status line, then:

1. It dispatches a **`kando-worker` on a synthetic brief** — no board ticket is
   created. The brief carries the failing run's output and URL, the merge sha, the
   ticket keys in the batch, and the diff range to read. The fixer works on the loop
   branch — which holds the whole batch already, `main` differing from it only by the
   merge commit — holds to TDD where the failure has a testable surface, commits,
   pushes the branch, and reports `ready-for-review`.
2. An **independent `kando-reviewer`** judges the fix on its own diff range, through
   the same 3-round inner loop any ticket gets. A fixer that papers over a real bug is
   precisely what this gate exists to catch.
3. On review pass the coordinator **re-flushes**: merge, push, re-arm the waiter.

**Bounded at 2 fixer attempts per red flush.** The counter resets on green. On
exhaustion the coordinator:

- reverts the merge commit (`git revert -m 1 <merge-sha>`) and pushes, restoring
  `main` and production to the last green state;
- writes a `## 🤖 Claude — Blocked` section on every ticket in the batch, naming the
  red run and what both fixers tried;
- stops the loop, reporting the merge sha, the run URL, the revert sha, the batch
  tickets, and the fixer attempts.

The loop branch keeps every commit, so no work is lost — only unshipped.

Fixer attempts do not count toward the `done` / `human-needed` counters, the
circuit breaker, or `max-tasks`. A fix is not a ticket; it has its own bound.

**Known manual-recovery point.** After an exhausted red flush the batch's tickets are
still tagged `pending-ship`, so no later run will re-select them. That is deliberate:
their code is written and reviewed, and re-working it is not the right recovery. A
human reads the Blocked notes and decides. The loop does not dig itself out.

### 6. What "done" means now

Unchanged in substance, later in time. A ticket is `done` when its change is on `main`
**and** verification has gone green — which now happens at a flush rather than at the
ticket. The worker's terminal reports shrink to `ready-for-review`, `pushed` (meaning
"pushed to the loop branch"), and `blocked`; the worker no longer receives
`verified green, finish up`, because the coordinator does those board writes itself.

## Changes by file

**Code:**

- `src/tools/loop.ts` — `selectNextTask` excludes tickets tagged `pending-ship`,
  mirroring the existing `human-needed` exclusion. This is the only server change, and
  the whole design rests on it. Inert until the skill uses it.
- `src/tools/loop.test.ts` — a `pending-ship` ticket is not returned; clearing the tag
  makes it workable again; a board with no such tag behaves exactly as today.
- `src/init.ts` — `LOOP_AUTH_BLOCK` states that the loop's *subagents* push to `main`.
  Under this design workers push only the loop branch and the coordinator owns `main`;
  the text must say so. `ensureLoopAuthorization` is currently a marker-keyed no-op, so
  every already-installed repo would keep the stale wording forever — it must
  **replace** an existing block instead of skipping, so re-running `init` refreshes it.
- `src/init.test.ts` — covers the replace-not-skip behaviour, and that a CLAUDE.md with
  no block still gets one.

**Prose:**

- `skills/kando-autonomous-loop/SKILL.md` — the bulk of the work: branch setup at run
  start, steps 3–7 lose the per-ticket verification wait, a new flush section, the red
  path, worker prompt steps 7–8 rewritten, and the "Never" list revised.
- `agents/kando-worker.md` — the standing-authorization paragraph becomes
  branch-scoped.
- `README.md` — the `/kando-loop` verification paragraph gains the batching story.

**Not proposed:** tests asserting on skill markdown wording. The repo does not do that
today, and it would ossify prose that has to stay editable.

## Sequencing

1. `selectNextTask` exclusion plus its tests — standalone and inert.
2. The `SKILL.md` rewrite — the behaviour change.
3. `init` block refresh, agent definition, README.

## Rejected alternatives

**A cheap per-ticket CI gate.** Compose a second, e2e-free command set (build,
typecheck, unit) and run it on every branch push, so breakage is caught at the ticket
that caused it rather than at a batch of ten. Rejected: it reintroduces a per-ticket
CI wait — smaller, but the thing this design exists to remove — and the per-ticket
gate that already exists (a green local suite plus an independent reviewer) covers
most of what it would catch. A batch that goes red gives you several suspects; the
loop branch keeps every commit separately, so bisecting is available when it matters.

**Local commits, unpushed until flush.** Simpler — no branch bookkeeping, linear
history — but unpushed work dies with the machine, and after ten tickets that is a
whole story lost.

**Per-ticket branches merged at flush.** The most granular, and the easiest place to
drop one bad ticket from a batch. Rejected as the most git bookkeeping in the skill
for a recovery path that a `git revert` of one commit on the loop branch already
covers.

**Auto-revert on the first red flush.** Fastest blast-radius control, but it throws
away a fix the loop is usually capable of making, and turns every flaky e2e run into
an aborted batch. Revert survives as the *last* act after two failed fixers, where the
evidence says the loop cannot fix it.

**Moving tickets to the last column at review-pass, backfilling the deep link at
flush.** The board would move promptly and no `pending-ship` tag or server change
would be needed. Rejected because "Done" would then mean "merged to a branch", and the
one thing the last column has to mean is "in production".
