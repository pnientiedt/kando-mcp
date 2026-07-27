# kando-loop token cost: tier the models, stop re-fetching the board

**Date:** 2026-07-27
**Status:** approved, ready for planning

## Problem

A `/kando-loop` run costs far more than the work it does. The cost is
`fixed-overhead × agent-count`, and both terms are large.

**Agent count.** Per ticket the coordinator dispatches one worker plus one reviewer
per review round (up to 3). At the `max-tasks = 25` cap that is 50–100 cold agent
boots in a single run.

**Fixed overhead per boot.** Every dispatched subagent is a fresh context. It re-pays,
from zero:

- the target repo's `CLAUDE.md` — in `~/git/kando`, one repo this loop is pointed at,
  that file is 14,032 words (roughly 20–25k tokens);
- the `kando` and `test-driven-development` skills, both required background;
- the worker or reviewer prompt inlined from `SKILL.md`.

**Model tier.** Neither dispatch in `skills/kando-autonomous-loop/SKILL.md` passes a
`model`, so every worker and every reviewer inherits the session model. In practice
that is Opus — the most expensive tier — for work that is largely execution against
written criteria.

On top of that, worker step 2 calls `get_board` on every single ticket for one field.

## Goals

- Cut the cost of a loop run substantially, without weakening any quality gate.
- Keep the change inside the reusable plugin skill, so every repo the loop runs
  against benefits.
- Keep every change independently reversible.

## Non-goals

- **Trimming the target repo's `CLAUDE.md`.** This is the single largest per-boot cost
  and the largest available saving, but it lives in `~/git/kando`, not here, and it
  helps only that one repo. Explicitly out of scope; worth doing separately.
- **Reducing the number of review rounds.** Considered and rejected — see
  "Rejected alternatives".
- **Narrowing what later review rounds see.** Considered and rejected — see
  "Rejected alternatives".
- Concurrency. The coordinator stays strictly sequential.

## Design

### 1. Explicit model tiering on dispatch

`SKILL.md` step 3 (worker) and step 4a (reviewer) gain an explicit `model: sonnet` on
the `Agent` call. The tool's `model` parameter takes precedence over inheritance for
any non-`fork` subagent type, so `general-purpose` accepts it.

Both roles execute against criteria that are already written down: the worker
implements TDD against the ticket's `## 📋 Specification`, the reviewer judges a diff
against stated intent. Neither is the judgment-heavy seat.

**The reviewer stays on Sonnet, not Haiku.** Its hardest task is deciding whether tests
are "trivial / gamed / do not exercise the change / were clearly not written
test-first". That is the discrimination the entire review gate exists to make, and it
is the last thing to cheapen.

**The coordinator is not overridden** and keeps the session model. It owns verdict
interpretation, the circuit breaker, the `block it` decision, and the waiter exit-code
handling — where a wrong call is expensive. `SKILL.md` states this rationale in a
sentence, so the tiering reads as deliberate rather than as an oversight to "fix".

### 2. Hoist `get_board` out of the worker

Worker step 2 currently calls `get_board` solely to find the bot's member `userSub` —
the skill says so explicitly. That is a full board payload (every story, subtask, and
tag) paid once per worker, and it grows as the board grows.

The coordinator fetches it instead:

- **Once per board, not once per run.** A multi-target run can span several boards, so
  the lookup is keyed by board and performed on that board's first ticket.
- It caches the bot `userSub`, the in-progress column, and the last column.
- It substitutes those literally into the worker prompt at dispatch.

Worker step 2 becomes `get_ticket KEY-N` alone. Nothing else in the worker needs the
board: `ensure_tag` takes the board key, which is derivable from the `KEY-N` prefix,
and returns the tag id.

**Surviving the heartbeat.** The coordinator ends its turn during the step-5
verification wait and is re-invoked by `Monitor` heartbeats, so this cache cannot live
only in context. The coordinator restates a compact run header each turn:

```
board TSK → userSub <id>, in-progress "<col>", last "<col>"
```

If the header is absent on re-invocation, it re-fetches. Worst case is one board fetch
per board per interruption, still far below one per worker.

## Rejected alternatives

**Narrowing rounds 2–3 to the fix diff.** Proposed and dropped. Two defects. First, if
round 1 rejects and round 2 approves, then a round-2 reviewer that saw only the fix
diff means *no reviewer ever approved the complete change* — one saw a version that was
wrong, the next saw a patch. Second, handing round 2 the prior round's findings anchors
it to a predecessor's framing, contradicting the reviewer prompt's own premise ("do not
trust any implementer narrative"; review the diff directly). The payoff did not justify
either: rounds 2–3 only occur when round 1 blocked, so it optimizes the uncommon path,
and the diff is a small share of a boot whose cost is dominated by `CLAUDE.md` and the
required skills.

**Reducing max review rounds from 3 to 2.** Rejected. It converts tickets that would
have converged on round 3 into `human-needed`, trading a real behavior regression for
one occasional agent boot.

**Risk-gating the reviewer (skipping it for docs/config-only diffs).** Rejected. The
reviewer's stated duties include catching bogus "no testable surface" TDD exemptions,
and a docs-only diff is precisely where that claim hides. It removes the gate at its
weakest point for very little.

**Putting the reviewer on Haiku.** Rejected; see design section 1.

## Expected effect

Arithmetic, not measurement — there is no baseline instrumentation in the repo.

Model price dominates, and Opus→Sonnet covers the worker and reviewer, which together
account for the large majority of a run's tokens. That alone is on the order of a
3.5–4× reduction overall. Change 2 removes one full board payload per worker on top;
its size scales with the board.

## Accepted tradeoffs

- **Sonnet workers will sometimes need a review round that Opus would not have.** Each
  extra round is another reviewer boot, which eats into the saving. This is the thing
  to watch on the first real run: if `human-needed` from the 3-round path rises
  noticeably, reconsider the worker tier.
- **Cached column names can go stale** if a board is reconfigured mid-run. Low impact
  and self-healing on the next re-fetch.

## Verification

The changed artifact is a skill document, not code, so the check is behavioral: a real
`/kando-loop` run on a live board, confirming that dispatched workers and reviewers
report Sonnet, that `get_board` is called once per board rather than once per ticket,
and that the review gate behaves exactly as before.
