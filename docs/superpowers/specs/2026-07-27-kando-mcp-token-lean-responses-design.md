# Token-lean MCP responses

**Date:** 2026-07-27
**Status:** agreed
**Ships as:** v0.6.0

## Problem

Every Kando MCP read costs far more context than the information it carries. Measured
against the real `KDO` board (62 items) by driving the built server over stdio:

| call | chars | ~tokens |
|---|---|---|
| `get_board KDO` | 586,573 | ~162,900 |
| the same board with `body` stripped | 30,681 | ~8,500 |
| `get_ticket KDO-54` (container, 5 subtasks) | 72,923 | ~20,300 |
| `move_ticket KDO-54` echo | ~69,000 | ~19,000 |

**94% of the board payload is ticket bodies** — 549,833 chars across 62 items, the
largest ~18,000 chars each. Those are the specs `/kando-refine` writes, so they will
keep growing. Pretty-printing costs 1.4% and UUIDs 2%; both are noise by comparison.

Three leaks share one root cause — the tools return whole objects:

1. `get_board` / `search_tickets` return `flattenBoard()`, which carries `body` for
   every item (`src/tickets.ts:58`). The `fields` param drops whole *sections*, not bodies.
2. Every mutation echoes the full object. `storyFields` embeds `subtasks { … }`
   (`src/operations.ts:13`), so confirming a column change costs ~19,000 tokens.
3. `get_ticket` on a container returns all sibling subtask bodies.

## The rule

**Lists identify; `get_ticket` explains.** A ticket body appears in exactly one place in
the whole tool surface: `get_ticket`, for the one ticket that was asked about.

The corollary is what makes it usable: **inputs must accept what outputs show.** Once a
list reports `col:"Open"` and `tags:["refined"]` instead of UUIDs, a caller holding only
a list response has no UUID to pass back. Every id-shaped input therefore also accepts
its human-readable form.

## Target shapes

### Lean item

Used by `get_board.items`, `search_tickets`, `list_archived`, and `get_ticket.subtasks`.
Optional keys are **omitted** when null, empty, or false.

```json
{ "ticket": "KDO-22", "title": "Backend foundation", "col": "Open",
  "parent": "KDO-2", "tags": ["refined"], "assignee": "bot@example.com",
  "snoozed": true, "release": "v1.0" }
```

`parent` is the containing story's `KEY-N` (subtasks only). Raw `id`, `storyId`,
`columnId` are gone — the tool surface is `KEY-N`-addressed throughout.

### `get_board`

```json
{ "board": { "key": "KDO", "name": "Kando", "role": "EDITOR",
             "columns": ["Open", "In Progress", "Done"] },
  "items": [ /* lean, ALL columns including Done */ ],
  "tags": ["claude", "human-needed", "refined"],
  "releases": [{ "name": "v1.0", "targetDate": "2026-08-01" }],
  "members": [{ "email": "a@example.com", "name": "Ada", "role": "EDITOR" }] }
```

Columns are ordered labels, matching what `list_boards` already returns. Done items stay
in — hiding a third of the board by default was rejected as surprising.

The `fields` param is unchanged.

### `get_ticket`

The only tool that returns a body.

```json
{ "ticket": "KDO-54", "kind": "story", "title": "…", "col": "In Progress",
  "body": "<full text>", "tags": ["refined"], "assignee": "bot@example.com",
  "estimateHours": 4, "visibleAt": "2026-08-01T00:00:00Z",
  "subtasks": [ /* lean, NO bodies */ ] }
```

`subtasks` appears only for containers. A subtask returns its own `body` and a `parent`,
never its siblings' bodies.

### Mutation acks

| tool | response |
|---|---|
| `move_ticket` | `{"ticket":"KDO-54","col":"In Progress"}` |
| `update_ticket` | `{"ticket":"KDO-54","updated":["body","tags"]}` |
| `create_story` / `create_subtask` | `{"ticket":"KDO-63","title":"…","col":"Open"}` |
| `reorder_ticket` | `{"ticket":"KDO-5","position":"top"}` |
| `archive` / `unarchive` / `delete` | `{"archived":"KDO-5"}` etc. |
| `ensure_tag` | `{"tag":"refined","created":false}` |
| tag / release CRUD | `{"tag":"refined","created":true}` etc. |

`unarchive_ticket` currently returns a full story and joins the ack pattern. `ensure_tag`
stops returning an `id` — callers apply tags by name.

The ack's `col` is **the label the caller passed** (already resolved on the way in), not
a value read back from the response. That keeps the ack free of an extra round trip.

## Inputs accept human-readable identifiers

| input | accepts |
|---|---|
| `column` (`move_ticket`, `create_*`, `update_ticket`, `search_tickets`) | column label (case-insensitive) or id |
| `tag` (filter), `tags` (create/update), tag CRUD | tag name or id |
| `release` (filter), `releaseId`, release CRUD | release name or id |
| `assignee` | email, userSub, or `"me"` |

`"me"` resolves to the account the server is authenticated as. The server already knows
it — `registerLoopTools` takes `botEmail` — so this removes the loop coordinator's need
to cache a `userSub` at all.

Resolution fetches the board once per call, only when a non-id value needs resolving.
Unknown or ambiguous values raise `KandoError('BAD_INPUT')` naming the board's valid
labels / names / emails. An unknown **tag name is an error pointing at `ensure_tag`** —
it never auto-creates.

## Implementation

### `src/shape.ts` (new)

Pure functions, no network, no zod, no MCP types:

- `buildContext(boardContainer)` → lookups: tag id→name, release id→name,
  userSub→email, item id→`KEY-N`, column id→label
- `leanItem(item, ctx)` → the lean shape, omitting empty keys
- `ack(ticket, changed)` → the mutation confirmation

All shaping decisions live in one file that is testable without a server. `read.ts` and
`tools/tickets.ts` stay thin.

### `src/resolve.ts` (new)

`resolveColumn`, `resolveTag`, `resolveRelease`, `resolveAssignee` — each takes the board
container plus a user-supplied string and returns an id, or throws `BAD_INPUT` listing
the valid options. Pure, so every error path is unit-testable.

### GraphQL

Add **slim mutation selections** (`id num columnId` — no `body`, no `subtasks`). Without
them the server still fetches the ~69,000 chars and discards them, which fixes the token
cost but not the latency. Read paths keep the existing fat selection: `next_task` needs
`visibleAt` / `tags` / `assignee` / `columnId`, `planReorder` needs `rank`, and
`search_tickets` still matches `text` against bodies server-side.

### Formatting

`toolText` drops the 2-space indent (`JSON.stringify(value)`), ~26% off every response.

## Prompt surface

Tool descriptions are loaded into every session and are as much documentation as the
skills. These state the old contract and must change with it:

- `src/tools/read.ts:73,79,132,136-137` — `'…columns + userSubs'`, `'member userSub'`,
  `'tag id'`; `get_board` / `search_tickets` descriptions should state that bodies are
  not included and name `get_ticket` as the way to get one
- `src/tools/tickets.ts:88,146,151,172` — `'column id'`, `'target column id'`,
  `"member userSub; '' to unassign"`
- `skills/kando/SKILL.md:82,90` — the `userSub` / tag id / release id filter list, and
  "before applying its id"; add a statement of the lists-identify rule
- `skills/kando-refine/SKILL.md:37,58,64` — "apply its id", and the
  "tags minus `human-needed`" step, which becomes name-based
- `skills/kando-autonomous-loop/SKILL.md:59-68,254-255` — the
  `get_board(fields:["board","members"])` call, the cached `userSub`, the run-header
  format, and "Assign the ticket to `<userSub>`". With `"me"` the cache holds only
  column names and the `fields` call narrows to `["board"]`
- `agents/kando-worker.md:25` — "the bot's `userSub` and the column names"
- `README.md:52` — Tools section, plus a short note on the response contract

**Verified to need no change:** `agents/kando-reviewer.md` (no board tools),
`commands/*.md`, `assets/kando-workflow.mjs` and `src/hookLogic.ts` (shape-agnostic),
`CLAUDE.md`, and `skills/kando-autonomous-loop/SKILL.md:103-122` — the `storyId` flush
comparison, which is safe precisely because `next_task` is out of scope.

`docs/superpowers/specs|plans/*` are historical records of completed work and are not
retro-edited.

## Testing

- `shape.ts` and `resolve.ts` unit tests over a fixture board derived from the real
  `KDO` shape (trimmed, anonymized), covering every error path
- a regression test asserting **no `body` key can appear** in `get_board` /
  `search_tickets` / `list_archived` output
- a **size-budget test**: the fixture board's `get_board` output stays under a fixed
  char ceiling (measured value + ~20% headroom), so this cannot silently re-inflate
- updated `src/tools/read.test.ts`, `src/tools/tickets.test.ts`
- `src/live.e2e.test.ts` against the Dev board

## Out of scope

- **`next_task`'s shape.** Already tiny, and the loop's flush decision compares its
  `storyId` (`skills/kando-autonomous-loop/SKILL.md:103`). Not worth disturbing in a
  token-cost change.
- **The `.claude/` refresh.** `init.ts:205-207` generates `.claude/` from the packaged
  `skills/`, `agents/`, `commands/`, but `.claude/` is also checked into git and has
  already drifted (309 vs 179 lines in the loop skill). Only the packaged sources are
  edited here. Consequence, to be captured as a follow-up ticket: until
  `npx kando-mcp init` is re-run, this repo's own `/kando-loop` runs skills describing
  the old contract against a server serving the new one.

## Expected result

| call | today | after |
|---|---|---|
| `get_board KDO` | ~162,900 tok | ~2,800 tok |
| `get_ticket KDO-54` | ~20,300 tok | ~2,200 tok |
| `move_ticket KDO-54` | ~19,000 tok | ~11 tok |
