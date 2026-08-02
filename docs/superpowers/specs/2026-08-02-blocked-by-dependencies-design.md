# Blocking dependencies: `next_task` respects `blockedBy`

**Date:** 2026-08-02
**Status:** approved, ready for planning

## Problem

Kando gained blocking dependencies (KDO-94, live in Dev **and** Prod as of
2026-08-02): a story or subtask carries `blockedBy: [ID!]!`, the ids of **same-board**
items that must be finished before it can be worked. The inverse direction
("blocking") is derived on read, never stored.

The MCP server does not know the field exists. It is not in any GraphQL selection, so:

- `next_task` hands the autonomous loop tickets whose prerequisites are not done. The
  loop then implements them out of order — exactly the failure the human drew the
  dependency to prevent.
- `get_ticket` cannot show a dependency, so neither a human nor a worker agent can see
  why a ticket should wait.
- No write tool can set or clear one, so the MCP suite can express a plan it is
  incapable of recording.

## Goals

- `next_task` never returns a ticket whose dependencies are unresolved.
- A ticket's dependencies are visible in the one response that explains a ticket.
- The suite can set and clear dependencies, addressed by `KEY-N` like everything else.
- The shipped skills teach the feature, so an agent reaches for it unprompted.

## Non-goals

- **Cross-board dependencies.** The backend stores same-board ids only.
- **Surfacing the derived "blocking" direction.** It is a UI affordance; nothing in the
  MCP flow needs to know what a ticket blocks.
- **Showing dependencies in lists.** `get_board` / `search_tickets` identify tickets;
  `get_ticket` explains them. That split is what keeps a 60-ticket board cheap.
- **Cycle detection.** A cycle simply means neither ticket is ever served — visible,
  self-limiting, and the backend's concern if it becomes one.

## Resolution rule

One rule, used by every consumer. A blocker id is **resolved** when:

| Blocker's state | Resolved? | Why |
|---|---|---|
| Not found on the board | yes | `getBoard` excludes archived rows, and a hard delete cascade-strips inbound refs (`dependencies.ts`). Archived and deleted are therefore indistinguishable here, and both mean "not standing in the way". Matches the web UI's render guard in `web/src/lib/dependencies.ts`. |
| In the board's **last column** (Done) | yes | Last column = Done, the rule `next_task` already applies to the unit it is considering. |
| Anything else | **no — it blocks** | |

**A container blocker is judged by its subtasks.** A story with ≥1 live subtask has no
authoritative `columnId` of its own — its status is derived. Done for a container means
*every live subtask sits in the last column* (the backend's `deriveColumnId`, whose
first branch is exactly this). A container blocker is otherwise unresolved. This is the
only place the MCP derives container status; it is contained in the blocking module and
mirrors what the human sees on the board.

## Architecture

A new pure module, `src/blocking.ts`, in the same spirit as `shape.ts` and `rank.ts`:
give it a board container, it answers dependency questions without a server.

```
buildBlockerIndex(bc) -> BlockerIndex     // id -> {num, resolved}, plus the board key
unresolvedBlockers(item, parent, index) -> string[]   // KEY-N, sorted by num
blockerTickets(item, index) -> string[]               // every LIVE blocker, KEY-N, sorted
```

`buildBlockerIndex` makes one pass over `bc.stories` (and their subtasks), sorting the
columns once, and records for each item whether it counts as Done under the rule above.
Both consumers then answer in O(number of blockers).

`unresolvedBlockers` takes the item **and its parent story** because of the inheritance
rule below; the parent is `null` for a standalone story.

### Consumer 1 — `next_task` (`src/tools/loop.ts`)

One more clause in `selectNextTask`'s eligibility predicate, alongside Done / snoozed /
human-needed / pending-ship / assigned-to-a-human:

```ts
// the predicate already destructures the unit; it now needs `kind` and `story` too
if (unresolvedBlockers(item, kind === 'subtask' ? story : null, index).length) return false;
```

**A subtask inherits its container's blockers.** Work units are standalone stories and
subtasks — never a container story itself — so a dependency a human drew on a container
would otherwise have no effect at all on the loop. Inheriting it is what makes "this
story waits for KDO-7" mean what a human means by it.

The clause sits in the shared predicate, so it applies at **every scope**: board, story,
and single-subtask. `next_task KDO-5` on a blocked ticket returns `{none:true}`, exactly
as it already does for a snoozed or human-needed one. A blocked ticket is not workable;
how you asked for it does not change that.

### Consumer 2 — `get_ticket` (`src/shape.ts`)

`leanDetail` gains two fields, both omitted when they would be empty:

- `blockedBy: ["KDO-7","KDO-9"]` — every blocker that still exists on the board, as
  `KEY-N`, sorted by num. Resolved ones stay listed: the association is part of the
  ticket's record, and dropping it the moment the blocker went Done would erase why the
  ticket was ordered as it was.
- `blocked: true` — present only when at least one of them is unresolved. This is the
  field that makes a silent `next_task` skip diagnosable.

`leanDetail` is pure and takes only `raw` + `BoardCtx` + `DetailOpts` today. The index
reaches it through `DetailOpts` (`blockers?: {list: string[]; blocked: boolean}`),
computed by the caller in `read.ts`, which already holds the board container. No
signature churn beyond that one optional field, and `shape.ts` stays free of board
traversal.

Lists are untouched: `leanItem` gains nothing.

### Consumer 3 — the write tools (`src/tools/tickets.ts`, `src/resolve.ts`)

`blockedBy?: string[]` — `KEY-N`s — on `update_ticket`, `create_story` and
`create_subtask`. The backend accepts the argument on all four underlying mutations.

- Resolution lives in `resolveBlockedBy(bc, refs)` in `resolve.ts`, beside
  `resolveTagIds` / `resolveAssignee` / `resolveReleaseId`, using the board container
  those helpers already share. `KEY-N` -> the id of the story or subtask with that
  `num`. A `KEY-N` that names no ticket **on this board** is an error naming the
  ticket — never a silent drop, the same contract as applying an unknown tag. That one
  rule covers both a typo and a genuine cross-board reference.
- `[]` clears every dependency. This is deliberately unlike `''`-clears-a-scalar
  (`assignee`, `releaseId`, `visibleAt`): `blockedBy` is a list, and an empty list is
  its own natural "none".
- Self-reference (`update_ticket KDO-5 blockedBy:["KDO-5"]`) is refused with a clear
  message. It is always a mistake, and it would make the ticket permanently unworkable.
- `buildUpdateVars` passes `blockedBy` through only when provided, like every other
  patch field. `resolvePatch`'s `needs` guard gains `blockedBy !== undefined` so the
  board fetch happens when — and only when — something needs resolving.
- The ack is unchanged in shape: `blockedBy` appears in its `updated` list like any
  other changed field.

### The GraphQL layer (`src/operations.ts`)

- `blockedBy` added to `storyFields` and `subtaskFields`, so `getBoard`,
  `archivedItems` and the resolve paths all carry it.
- `$blockedBy: [String!]` threaded into `CREATE_STORY`, `UPDATE_STORY`,
  `CREATE_SUBTASK`, `UPDATE_SUBTASK`.
- The ack selections (`ackStoryFields` / `ackSubtaskFields`) stay lean — a mutation
  acknowledges, it does not read back.

A server predating KDO-94 would reject the new selection outright. Both hosted stages
are past it (KDO-94's release run deployed Dev and Prod green on 2026-08-02), and the
MCP has never supported a self-hosted stage older than the schema it ships against, so
no compatibility shim.

## Instructions that ship

Every file below has a byte-identical tracked mirror under `.claude/`; both copies
change together.

- **`next_task`'s tool description** — blocked joins the list of what it skips, with the
  inheritance rule stated: a subtask is skipped when its container is blocked.
- **`skills/kando/SKILL.md`** — a short *Dependencies* subsection: what `blockedBy`
  means, that blockers are same-board `KEY-N`s, that a blocker counts as resolved once
  it is Done or archived, how to set and clear one, and that `get_ticket` reports
  `blocked: true`.
- **`skills/kando-refine/SKILL.md`** — when a refinement splits a story into subtasks
  that must happen in order, wire `blockedBy` at create time instead of relying on
  rank. Rank is a preference; a dependency is a constraint.
- **`skills/kando-autonomous-loop/SKILL.md`** — a blocked ticket is one more reason
  `next_task` returns `{none:true}`, and it is not a reason to stop: the blocker may be
  a ticket the loop itself is about to finish.

## Testing

TDD throughout; every unit here is pure and tested without a server.

- **`src/blocking.test.ts`** — the resolution matrix: blocker Done, blocker in an
  in-progress column, blocker absent (archived/deleted), container blocker with all
  subtasks Done, container blocker with one subtask not Done, empty `blockedBy`, a
  board whose `blockedBy` is missing entirely (pre-KDO-94 shape).
- **`src/tools/loop.test.ts`** — a blocked unit is skipped and the next eligible one
  served; a subtask whose **container** is blocked is skipped; both become workable
  once the blocker reaches the last column; a blocked single-subtask target returns
  none.
- **`src/shape.test.ts` / `src/tools/read.test.ts`** — `blockedBy` + `blocked` render
  as `KEY-N`s and are omitted when there are none; lists still carry neither.
- **`src/resolve.test.ts`** — `KEY-N` -> id for a story and a subtask, unknown/off-board
  `KEY-N` raises, `[]` resolves to `[]`.
- **`src/tools/tickets.test.ts`** — `blockedBy` reaches the mutation variables on
  update and both creates, is absent when not provided, `[]` clears, self-reference is
  refused.
- **`src/tools/registry.test.ts`** — the new input appears on the three tools' schemas.

## Risks

- **A dependency on an archived ticket reads as resolved.** Inherited from the backend
  (archive deliberately does not cascade-strip) and from the web UI, which drops the
  chip the same way. Consistency with what the human sees beats a stricter rule that
  would strand a ticket behind something no longer on the board.
- **Container status derivation is now duplicated in a third place** (backend, web,
  here). Confined to `blocking.ts`, exercised directly by its tests, and small enough
  that drift would surface as a failing blocker test rather than silently.
