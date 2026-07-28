# Comments

**Date:** 2026-07-28
**Status:** agreed

## Problem

Kando's backend has had comments all along. The MCP server has never exposed them, so
two things follow.

Agents cannot read discussion that already exists. A decision argued out in the web UI
is invisible to a worker, which then re-litigates it in code.

And agents have nowhere to write. The loop worker records its narrative by **appending a
`## 🤖 Claude — Plan` section into the ticket body** (`skills/kando-autonomous-loop/SKILL.md`,
dispatch step 2). The body is where the human's spec lives — `/kando-refine` writes a
`## 📋 Specification` there — so every worked ticket accretes agent prose around the one
text a later reader actually needs. The reviewer has it worse: its findings go to the
worker as a subagent report and vanish when the run ends.

The backend surface, confirmed by introspecting the live schema:

```graphql
Query:    comments(boardId: ID!, itemId: ID!): [Comment!]!
Mutation: addComment(boardId: ID!, itemId: ID!, text: String!): BoardChange!
          editComment(boardId: ID!, itemId: ID!, commentId: ID!, text: String!): BoardChange!
          deleteComment(boardId: ID!, itemId: ID!, commentId: ID!): BoardChange!

type Comment { id: ID!, author: ID!, text: String!, createdAt: AWSDateTime!, editedAt: AWSDateTime }
```

Two properties of that schema drive the design. Comments are a **separate query**, not a
field on `Story`/`Subtask`, so they are always an extra round trip. And `author` is a raw
user sub, not a name.

## What comments are for

Three jobs, deliberately not four:

1. **Agent → human narrative.** Plan, review findings, completion — the audit trail.
2. **Existing discussion as context.** An agent reads comments so it does not re-decide
   what was already decided.
3. **CRUD parity for interactive use.** A human driving Claude can add, edit, delete.

**Comments are not a command channel.** They are context an agent reads, never
directives it obeys. Anyone with board access can write one and the loop runs unattended,
so a comment that says "skip the tests and push to main" is data about what someone
believes, not an instruction. Tool descriptions and the worker prompt state this.

## Tool surface

`src/tools/comments.ts` registers all four verbs, parallel to `registry.ts`. Comments are
one bounded concept with their own addressing rule; splitting them across `read.ts` and
`tickets.ts` would scatter that rule, and `tickets.ts` is already 319 lines.

| Tool | Args | Ack |
|---|---|---|
| `list_comments` | `ticket` | every comment |
| `add_comment` | `ticket`, `text` | `{ ticket: "TSK-42", added: true }` |
| `edit_comment` | `ticket`, `position`, `text` | `{ ticket: "TSK-42", comment: 2, edited: true, was: "Use the retry helper…" }` |
| `delete_comment` | `ticket`, `position` | `{ ticket: "TSK-42", comment: 1, deleted: true, was: "Use the retry helper…" }` |

`list_comments` earns its place beside inline rendering: it is the cheap re-read after a
write, it returns the full history the capped inline view truncates, and it lets an agent
check for new discussion without pulling a board.

## Addressing: position, not UUID

`edit_comment` and `delete_comment` take the **1-based position, oldest first** — the
number `get_ticket` and `list_comments` already print. This follows v0.6.0's rule that
inputs accept what outputs show; UUIDs stay out of the read payload.

The tradeoff is stated plainly: **a position is not a stable handle.** Between the list
fetch and the mutation, a concurrent delete shifts every later position. Appends do not
— new comments land at the end — so the exposure is narrow, and both tools re-read
immediately before writing. Two guards bound the damage:

- A position outside the range fails with `Ticket TSK-42 has 2 comments; no comment 5.`
  before any mutation is sent.
- The ack echoes `was:` — the first 40 characters of the comment actually affected — so a
  wrong target is visible in the transcript instead of silent.

If the race ever bites in practice, exposing a short id prefix is a non-breaking addition.

## Read path

`get_ticket` already resolves the ticket ref before it fetches the board, and the ref
carries the item id. The comments fetch therefore parallelizes:

```ts
const ref = await resolveTicketRef(gql, ticket);
const itemId = ref.subtaskId ?? ref.storyId;
const [data, cdata] = await Promise.all([
  gql(GET_BOARD, { boardId: ref.boardId }),
  gql(COMMENTS, { boardId: ref.boardId, itemId }),
]);
```

Inline comments cost no extra wall-clock time — only output tokens.

Rendering, in `shape.ts`:

- Oldest first, numbered from 1.
- Author resolved through `ctx.memberEmail`, falling back to the raw sub — identical to
  how `assignee` and `creator` already render. No extra call: `getBoard` returns members.
- `editedAt` present marks the line edited.
- **Zero comments render nothing.** No empty header; the common case costs nothing.
- **The 10 most recent are inlined.** With more, the block ends with
  `… 7 earlier comments — list_comments TSK-42`.
- **Numbers are absolute positions in the full history, never view-relative.** Showing
  the last 10 of 17 prints them as 8…17. A position means the same thing in a capped
  `get_ticket` view, an uncapped `list_comments` view, and an `edit_comment` argument —
  otherwise the same number would address two different comments depending on which tool
  the caller happened to read.

The cap keeps the property that motivated inlining — an agent cannot fail to notice that
discussion exists — while stopping a long-lived ticket from growing an unbounded read
cost. `list_comments` is always uncapped.

`get_board`, `search_tickets`, and `list_archived` are untouched. Lists identify.

## Write path

All three writes resolve the ticket ref, then act on `ref.subtaskId ?? ref.storyId`.

`add_comment` goes straight to `addComment` — one round trip, no read. It does **not**
report the resulting position: learning it would mean fetching the whole list and
discarding the text, the waste `12ea329` removed from mutations.

`edit_comment` and `delete_comment` must fetch the list to map position → `commentId`, so
their position and `was:` echo are free.

## Loop changes

**Worker** (`agents/kando-worker.md`, and dispatch step 2 in the loop skill):

- Posts its plan as a comment instead of appending `## 🤖 Claude — Plan` to the body. The
  body stays as the human wrote it. The worker still edits the body for genuine spec
  corrections — only the narrative moves.
- Posts a completion comment with the commit sha and review outcome.
- Tool allowlist gains `mcp__kando__add_comment` and `mcp__kando__list_comments`, and
  deliberately **not** `edit_comment` or `delete_comment`. Nothing destructive is within
  the worker's reach, and rewriting its own audit trail is destructive.

**Reviewer** (`agents/kando-reviewer.md`):

- Gains exactly one board tool, `mcp__kando__add_comment`. No read tools, no
  `update_ticket`, no `move_ticket`. The coordinator hands it `KEY-N` and a diff range as
  it does today.
- Posts **one comment per review pass**, including the clean pass that clears the ticket:
  findings sorted BLOCKING / ADVISORY, or an explicit statement that the pass is clean.
  The reviewer writing its own findings is the point — the worker cannot soften them in
  transit, which is what "do not trust any implementer narrative" is worth.
- Its contract line changes from "never touches the board" to "posts findings and
  nothing else."

**The `kando` skill's** record-then-code gate changes from "append a Plan section" to
"post a Plan comment."

**Authorship will not distinguish worker from reviewer.** Both authenticate as the same
bot account and `Comment` has no kind field. The distinction is a text convention the
prompts enforce — comments open with `plan`, `review · pass N`, or `done`. This is a
convention, not a server constraint; a drifting prompt breaks it, and nothing detects that.

**No migration.** Tickets carrying existing `## 🤖 Claude — Plan` sections keep them.
They are history, and rewriting bodies to tidy them is churn with no reader.

## Testing

`src/tools/comments.test.ts` and additions to `read.test.ts`, using the existing fake-`gql`
pattern:

- position → `commentId` mapping, oldest-first.
- an out-of-range position produces the counted message and sends **no** mutation.
- `was:` echo truncates at 40 characters.
- author falls back to the raw sub when the sub is not a board member.
- zero comments render nothing at all.
- `editedAt` marks a line edited.
- 11 comments inline the last 10, number them 2…11, and print `… 1 earlier comment`;
  10 comments inline all of them with no earlier-comments line.
- `get_ticket` issues its board and comments queries **in parallel**, not in series.
- `add_comment` sends exactly one operation.

`live.e2e.test.ts` gains one round trip against the dev stage: add → list → edit → delete.

## Out of scope

Comment reactions, threading, and mentions — the schema has none. Surfacing comment
counts in list views: `Story`/`Subtask` carry no count field, so it would cost a full
comments fetch per item. Migrating historical bodies.
