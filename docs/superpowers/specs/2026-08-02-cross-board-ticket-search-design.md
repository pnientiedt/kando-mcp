# Cross-board ticket search: `search_tickets` on `getTickets`

**Date:** 2026-08-02
**Status:** approved, ready for planning

## Problem

`search_tickets` filters one board, client-side. To answer "which tickets are assigned
to me", it calls `getBoard`, receives **every story and subtask with its full body**, and
throws almost all of it away in `filterItems`. On a 60-ticket board that is ~163,000
tokens of payload to produce a ~2,800-token answer — the fetch is the cost, and the
filter runs after it.

It also cannot answer anything about more than one board. An agent working two boards
searches twice and merges by hand.

Kando shipped the fix (KDO-93, live in Dev and Prod as of 2026-08-02):
`getTickets(filter, limit): TicketPage` — cross-board, server-side filtered, bodies
never returned. It was built for this suite and nothing else consumes it (the web
board's own filtering stays client-side in `matchesCombinedFilter`).

## Goals

- One search tool, backed by `getTickets`, that filters server-side.
- Reach the whole filter surface: multi-value tags/releases/assignees/columns, tag
  ANY/ALL, kind, archived, snoozed, limit.
- Search across every board the bot belongs to when no board is named.
- Say when a result was truncated, so an agent narrows instead of assuming completeness.

## Non-goals

- **Changing `get_board` or `get_ticket`.** They read one board and one ticket
  respectively; neither is a search.
- **Paging.** `TicketPage` has no cursor by design: `truncated` is alphabetical by
  board and therefore not a fair sample. It is a signal to narrow the query.
- **Returning bodies.** `getTickets` has no `body` field. "Lists identify, `get_ticket`
  explains" is unchanged.
- **Reporting blocked state.** `TicketSummary` carries no `blockedBy` (see Risks).

## The tool

`search_tickets` keeps its name and is rebuilt on `getTickets`. Every input is
optional; all of them combine with AND.

| Input | Type | Meaning |
|---|---|---|
| `boards` | `string[]` | board **keys** or ids. **Omitted = every board the bot is a member of.** |
| `tags` | `string[]` | tag NAMES, resolved per board by the server |
| `tagMode` | `"any"` \| `"all"` | default `any` |
| `releases` | `string[]` | release names |
| `assignees` | `string[]` | member `userSub`s, or `"me"` |
| `columns` | `string[]` | column labels **or** ids, case-insensitive |
| `text` | `string` | matches title + body; never returns a body |
| `kind` | `"story"` \| `"subtask"` | |
| `archived` | `"live"` \| `"archived"` \| `"all"` | default `live` |
| `snoozed` | `"show"` \| `"hide"` \| `"only"` | default `show` — a search must not silently drop a future-dated ticket |
| `limit` | `number` | 1–500, default 100 |

**Enums are lowercase on the way in and uppercased on the wire.** The suite's rule is
that everything is addressed the way it is displayed; `ARCHIVED` is wire vocabulary.

**Defaults are the server's, expressed by omission.** The tool sends only what the
caller passed, so the default for `archived`, `snoozed`, `tagMode` and `limit` lives in
exactly one place (the backend's `validate.ts`) and cannot drift.

**Board keys resolve locally; everything else resolves server-side.** `getTickets` takes
`boardIds`, so a key like `KDO` is translated through one `myBoards` read — the existing
`resolveBoardId`, generalized to a list so N keys cost one round trip. Tag, release and
column names are deliberately NOT resolved here: they are per-board registries, and the
server resolves each against its own board. That is what lets one name mean the right
thing on four boards at once.

**`assignees` takes a `userSub` or `"me"`, not an email.** The backend matches raw subs
and resolves the `"me"` sentinel itself. An email would need the board's member list —
which is exactly the per-board read this tool exists to avoid — so it is not accepted.
`"me"` is the case that actually matters for an agent, and it costs nothing.

## Response

An envelope, because truncation must be sayable:

```json
{"tickets":[{"ticket":"KDO-12","title":"Blocked one","col":"Doing","tags":["claude"],
             "assignee":"bot@example.com","subtasks":3}],
 "truncated":true,"boards":4}
```

- `tickets` — always present, possibly empty.
- `truncated: true` — only when the server truncated. Its absence means the result is
  complete for the filter given.
- `boards` — the fan-out size, only when more than one board was searched. On a
  single-board search it says nothing worth paying for.

Each row keeps the existing `leanItem` vocabulary — `ticket`, `title`, `col`, and then
`parent`, `tags`, `assignee`, `snoozed`, `release` only when set — plus:

- `subtasks: N` when a story has live subtasks. This is what distinguishes a **container**
  from a **standalone**, which is the difference between "move it" and "move its
  subtasks". `getBoard` never made that visible in a list; here it is free.
- `archivedAt` when the row is archived.

**No per-row board field.** `ticket` is `KEY-N` and the key names the board, so a board
column would repeat it on every row of a cross-board result. `assignee` renders as the
`assigneeEmail` the server already resolved, falling back to the raw sub.

## Retiring `list_archived`

`archived: "archived"` returns exactly what `list_archived` returned, with the same
`archivedAt` on every row, over the same tool as every other search. Two tools for one
question is a choice an agent has to make on every call, so the tool is deleted.

Two consequences, accepted deliberately:

- **Order changes.** `list_archived` was newest-first. `getTickets` sorts by `KEY-N`
  (board key, then num) and **truncates in that order**, so re-sorting client-side would
  produce a "newest 100" that is nothing of the kind. Recency stays readable per row via
  `archivedAt`.
- **`ARCHIVED_ITEMS` stays.** `get_ticket` on an archived ticket needs the body, and
  `getTickets` has none. Only the tool goes; the operation and `archivedDetail` remain.

`unarchive_ticket`'s description currently points at `list_archived` by name and is
rewritten to point at the search instead.

## `TOO_BROAD` needs a message

With `boards` omitted, a bot belonging to more than 25 boards gets the resolver token
`TOO_BROAD`. `graphql.ts`'s `MESSAGES` table has no entry for it, so it would surface as
*"Something went wrong; the change was not saved."* — wrong twice over on a read that
saved nothing. It gets an entry naming the fix: pass `boards`, or narrow the filter.

`BAD_INPUT` already covers the bounded-list rejections (>25 boards, >20 tags, `limit`
outside 1–500, an over-long filter value): the backend rejects rather than clamping, and
the existing message is adequate.

## Architecture

- `src/operations.ts` — `GET_TICKETS`, selecting the `TicketSummary` fields the lean row
  needs and no others (notably not `boardId`/`boardName`/`columnId`/`kind`).
- `src/ticketSearch.ts` (new, pure) — `buildTicketFilter(input, boardIds)` maps the
  tool's lowercase inputs to the wire filter, omitting everything unset; `leanSummary(s)`
  maps one `TicketSummary` to a lean row. Pure, testable without a server, in the spirit
  of `shape.ts`.
- `src/tools/read.ts` — `search_tickets` becomes: resolve board keys → ids (only if
  `boards` was given), build the filter, one `gql(GET_TICKETS)`, shape the envelope.
  `list_archived` is removed.
- `resolveBoardIds(gql, boards)` joins `resolveBoardId` in `read.ts`: one `myBoards`
  read for the whole list, an unknown key named in the error.
- `src/graphql.ts` — the `TOO_BROAD` message.

## Testing

- `src/ticketSearch.test.ts` — filter mapping: enums uppercased; unset fields absent
  (not null); `"me"` passed through untouched; empty arrays treated as unset; lean row
  omits every empty field, sets `snoozed` from a future `visibleAt`, emits `subtasks`
  only when > 0 and `archivedAt` only when archived.
- `src/tools/read.test.ts` — `search_tickets` sends one `getTickets` call and no
  `getBoard`; board keys resolve to ids; omitted `boards` sends no `boardIds`;
  `truncated`/`boards` appear only when meaningful; `list_archived` is no longer
  registered.
- `src/graphql.test.ts` — `TOO_BROAD` maps to its message.
- `src/live.e2e.test.ts` — the archived-listing assertion moves to
  `search_tickets({boards:[key], archived:'archived'})`, which also proves the real
  schema accepts the query.

## Risks

- **Removing a tool is a breaking change** for anything that calls `list_archived` by
  name. The blast radius inside this repo is four references (README, `unarchive_ticket`'s
  description, the live e2e, the registration itself) and the shipped skills never
  mention it. It ships as a minor with the release note saying so.
- **No `blockedBy` in `TicketSummary`.** The dependency work merged the same day cannot
  be reported by this tool; `get_ticket` stays the only place a ticket's blockers are
  visible. Worth a follow-up ticket on the Kando side, not a reason to hold this.
