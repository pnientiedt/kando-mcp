---
name: kando
description: Use when the user asks to work on, implement, or look at a task tracked in Kando — a ticket KEY-N (e.g. TSK-42), work "on the board", or "in kando". Also use before writing repo code that fulfils a Kando ticket. Kando is the team's Kanban board reached through the kando MCP tools.
---

# Working with Kando

Kando is a Kanban board reached through the `kando` MCP tools (a bot account acts on your behalf). This repo is **not** tied to a specific board — always discover boards at runtime with `list_boards`.

## MANDATORY: record-then-code (this is the point of this skill)

When a task corresponds to a Kando ticket `KEY-N`, the ticket is the record of the work. **You may NOT run an `Edit` or `Write` in the repo for that ticket until the ticket both:**

1. **holds a `## 🤖 Claude — Plan` section** in its body (your breakdown), AND
2. **is in the in-progress column** (`move_ticket`, or move its subtasks if it's a container).

**And you may NOT consider the work finished until** the ticket holds a `## 🤖 Claude — Done` section and has been moved to the last column.

**Violating the letter of this is violating its purpose.** The whole reason this skill exists is so a human can open the ticket and see what you planned and did. Code without the ticket updated defeats it.

### Re-anchor per ticket — every time

At the **start of each ticket, even mid-session**, re-read this section and restate the steps. A skill you loaded for a *previous* ticket does **not** count. Switching tickets means starting the gate over.

### How it composes with the engineering skills

These do not replace the gate — they slot inside it:

- The plan you write into the ticket **is** your brainstormed plan. Brainstorm/design first if you like, then record it in the ticket **before** touching the repo.
- Move the ticket to in-progress **before the first failing test** — TDD's first `Write` is a repo write and is gated too.
- Write the `## 🤖 Claude — Done` section and move the ticket to the last column **before** finishing/merging the branch.

### Red flags — STOP, you are about to skip the gate

- "I'll get_ticket, then just start coding." → No. Plan section + in-progress column first.
- "I'll update the ticket at the end once it works." → No. The Plan goes in **before** the first edit.
- "This is quick / needs no code." → Still record the Plan and Done sections; still move the ticket.
- "I already read the kando skill earlier this session." → Doesn't count for a new ticket. Re-anchor.
- "The engineering skill (TDD/brainstorming) is telling me to write code now." → It slots inside the gate; the ticket comes first.

## The workflow (the 5 steps)

1. `list_boards` → pick the board (address it by **key**, e.g. `TSK`). Ambiguous? Ask.
2. `search_tickets` (or `get_board`) to find the ticket; `get_ticket KEY-N` for full detail.
3. **Gate — before any repo edit:** write the `## 🤖 Claude — Plan` section into the ticket (see "Recording your work"), then `move_ticket` it to the in-progress column (or move its subtasks if it's a container).
4. Do the work in the repo.
5. **Gate — before finishing:** write the `## 🤖 Claude — Done` section, then move the ticket to the last column (or move its subtasks). Use `archive_ticket` only if the user wants it closed/removed.

## Recording your work in the ticket

Two clearly-marked Claude sections, appended below the human's original content, which you **never** change. The body must end up shaped like this:

```
<the original description, unchanged>

---
## 🤖 Claude — Plan
- how you're breaking the work down: steps, files, approach

---
## 🤖 Claude — Done
- what you actually changed and where; anything left open
```

**Preserve the original.** `update_ticket` replaces the whole `body`; it does not append. So every time you write a section:

1. `get_ticket` first and take its current `body`.
2. Keep everything above your sections untouched; append the new section (or, if that Claude section already exists from an earlier pass, update **that section** in place — don't stack duplicates).
3. `update_ticket(ticket, { body: <the full combined text> })`.

Never send a `body` that drops the human's words, and never send a section-only body.

## The ticket model

- Every ticket is a **story** or a **subtask**, addressed as **`KEY-N`**.
- **Columns are the workflow states** (e.g. To Do / In Progress / Done), in board order.
- A story with **0 subtasks is standalone** — move it directly with `move_ticket`.
- A story with **≥1 subtask is a container**; its status is **derived from its subtasks**. Moving the container itself does nothing visible — **to progress a container story, move its subtasks.**

## Finding work

`search_tickets` with a board plus any of `column`, `assignee` (a member `userSub`), `tag` (tag id), `release` (release id), `text` (matches title + description). Filters combine with AND. `get_board` gives the whole board when you need the full picture.

## Editing

- `update_ticket` edits title, body, tags, assignee, releaseId, estimateHours, snooze (`visibleAt`), and column in one call. Provide only the fields you want to change.
- **Clearing a field:** pass an empty string `""` for `assignee`, `releaseId`, or `visibleAt`. Omit a field to leave it unchanged.
- `create_story` / `create_subtask` add new tickets (a subtask needs a parent story `KEY-N`). Pass `position` (`{to:'top'|'bottom'}` / `{before:'KEY-N'}` / `{after:'KEY-N'}`) to place one somewhere other than the bottom.
- `reorder_ticket` changes only a ticket's **priority order** within its peer group — `to: 'top'|'bottom'`, or `before`/`after` another `KEY-N` (exactly one). Peers: a subtask ranks among its parent story's subtasks in the same column, a standalone story among its column's standalone stories, a container story among the board's lanes. Use `move_ticket` to change the column.
- Tags and releases are per-board registries — create one with `create_tag` / `create_release` before applying its id.

## Archive vs delete

Prefer **`archive_ticket`** (reversible). Only use `delete_ticket` when a permanent hard delete is genuinely intended.

## When something fails

`UNAUTHORIZED` means the bot lacks the needed role on that board (EDITOR to write, VIEWER to read) — tell the user the bot must be invited to the board.
