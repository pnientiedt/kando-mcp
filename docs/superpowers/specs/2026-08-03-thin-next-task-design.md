# One decision point: `next_task` and blocking move to the backend

**Date:** 2026-08-03
**Status:** approved, ready for planning

## Problem

Two rules this server implements are now implemented by Kando itself, and better:

- **KDO-99** added `nextTask(target, excludeTags): [NextTask!]!` — a **verbatim port** of
  `src/tools/loop.ts`'s `selectNextTask`/`unitsFor`, three-tier ordering and reasoning
  comments included. It exists so anything that can reach the API can ask "what's
  workable" without reimplementing the rule.
- **KDO-98** added `activeBlockedBy` to `Story`, `Subtask` and `TicketSummary`: the
  subset of `blockedBy` still genuinely outstanding, derived by one function
  (`dependencies.ts#computeActiveBlockedBy`) that `getBoard`, `getTickets` and `nextTask`
  all share. **KDO-97** is the human decision behind it, and it is explicit: *"is this
  actually blocking?" is a resolved state, not a stored one, and it must be resolved in
  the backend. Every consumer that answers it independently is a place the answers can
  drift.*

`src/blocking.ts` is exactly such a consumer — a fourth copy of the rule, written a day
before the decision that says not to have one. `selectNextTask` is the same problem for
task selection: two implementations of one contract, kept in step by hand.

They agree today. Nothing keeps them agreeing.

## Goals

- Delete the duplicated rules; read the server's answers instead.
- Keep `next_task`'s response contract byte-identical, so the autonomous loop skill needs
  no protocol change.
- Surface blocked state in `search_tickets`, which KDO-96 made possible.

## Non-goals

- **Exposing `nextTask`'s cross-board fan-out** (omitted `target` → one workable ticket
  per board). Real capability, but the loop always passes a target, and it would mean a
  second response shape from one tool. Reachable later without breaking anything.
- **Any fallback for an older backend.** Both hosted stages are past KDO-99 (its release
  run deployed Dev and Prod green on 2026-08-03). v0.9.0 keeps working for anyone who
  stays on it; the next version simply requires a backend that has `nextTask`.
- **Changing the write path.** `blockedBy` is still set with `KEY-N`s through
  `resolveBlockedBy`; the stored field is unchanged and remains the editor's source of
  truth (KDO-97 is explicit that filtering the *stored* list on read would make a
  completed blocker impossible to unlink).

## `next_task`

```
nextTask(target, excludeTags: ["human-needed", "pending-ship"]) -> [NextTask!]!
```

The tool takes the list's first entry and maps it to today's response, or returns
`{none:true}` when the list is empty. `target` stays **required**, and `kind` is
lowercased (`STORY` → `story`) — both so the loop skill's protocol is untouched.

**`excludeTags` stays ours.** The server resolves the names per board but hard-codes
nothing, so `human-needed` and `pending-ship` remain this suite's conventions rather than
Kando's. That is the whole reason the argument exists.

Deleted with it:

- `selectNextTask`, `unitsFor`, `WorkScope`, `WorkItem` — the tier logic and its
  eligibility predicate.
- The target resolution: `resolveTicketRef` + `requireLive` + `resolveBoardId`. The
  server takes a board key or `KEY-N` directly.
- The `members` lookup that turned `botEmail` into a `userSub`. The server has the
  caller's identity, so "assigned to a human" becomes "assigned to someone other than
  me" — same behavior, no lookup. `registerLoopTools` loses its `botEmail` parameter;
  `ensure_tag` never used it.

### The error message that would regress

An archived target is `BAD_INPUT` server-side. Our table maps that to *"That didn't save
— a title/description is too long or a value isn't valid."* — write-shaped wording on a
read that saved nothing, the same defect `TOO_BROAD` had before v0.9.0.

`next_task` catches `BAD_INPUT` from this query and re-raises with a message naming the
two causes that actually produce it: the target is archived, or it is not a board key or
`KEY-N`. It cannot distinguish them — the server does not say which — so the message
names both, which is still far more useful than the generic one. The token stays
`BAD_INPUT`.

## Blocking

`src/blocking.ts` and `src/blocking.test.ts` are deleted. `get_ticket` reads the server's
answer:

```ts
blockers: {
  list: (raw.blockedBy ?? []).map((id) => ctx.ticketOf.get(id)).filter(Boolean),
  blocked: (raw.activeBlockedBy ?? []).length > 0,
}
```

`DetailOpts.blockers` and the `blockedBy` / `blocked` output fields keep their shape, so
`shape.ts` does not change at all. `blockedBy` still lists the raw stored relation (the
record of what was linked); `blocked` is now the server's verdict rather than ours.

An id that `ctx.ticketOf` cannot name is dropped, exactly as before — `getBoard` never
returns archived rows, so an archived blocker has no `KEY-N` to render. That this is also
the answer `computeActiveBlockedBy` gives (archived does not block) is now guaranteed by
sharing its output, not by two implementations happening to agree.

`search_tickets` rows gain, from `TicketSummary` (KDO-96):

- `blockedBy` — already `KEY-N` from the server, when non-empty.
- `blocked: true` — when `activeBlockedBy` is non-empty.

That closes the gap KDO-96 was filed for: a cross-board list can now show which rows are
unworkable, without a `get_ticket` per row.

## Architecture

- `src/operations.ts` — `activeBlockedBy` joins `storyFields`/`subtaskFields`;
  `GET_TICKETS`'s item selection gains `blockedBy activeBlockedBy`; a new `NEXT_TASK`
  selecting only what the response needs (`ticket kind id storyId columnId title` — not
  `boardId`/`boardKey`, since `KEY-N` carries the key).
- `src/tools/loop.ts` — `next_task` becomes ~20 lines around one query. The file loses
  its two largest functions and their doc comments; what remains is `ensure_tag`,
  `pickTagColors` and the wrapper.
- `src/tools/read.ts` — `get_ticket`'s `blockersFor` helper reads the two fields instead
  of building an index.
- `src/ticketSearch.ts` — `leanSummary` gains two fields.
- `src/blocking.ts`, `src/blocking.test.ts` — deleted.

## Testing

- `src/tools/loop.test.ts` — every `selectNextTask` test goes (the rule is tested in
  Kando's own suite now). What replaces them tests the wrapper: the query is sent with
  the target and both exclude tags; the first entry is returned with `kind` lowercased;
  an empty list is `{none:true}`; a `BAD_INPUT` is re-raised with the read-shaped
  message; `ensure_tag` still works with no `botEmail` in sight.
- `src/blocking.test.ts` — deleted.
- `src/tools/read.test.ts` — `get_ticket` reports `blocked` from `activeBlockedBy`, not
  from any column comparison: a blocker sitting in a non-last column with
  `activeBlockedBy: []` must read as **not blocked**. That single case proves the
  derivation really moved.
- `src/ticketSearch.test.ts` — `blocked` / `blockedBy` on a lean row, omitted when empty.
- `src/live.e2e.test.ts` — a `next_task` call against the deployed backend, which is the
  only check that the query, its arguments and the enum values are real.

## Risks

- **A hard dependency on a backend with `nextTask`.** Accepted above; the alternative is
  keeping the duplicate code alive to guard against a stage nobody runs.
- **Losing our own tests for the tier rules.** They now live in Kando's suite, against
  the implementation that actually decides. Keeping a copy here would be testing a
  function this repo no longer has.
