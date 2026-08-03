# kando-mcp

An [MCP](https://modelcontextprotocol.io) server that lets **Claude Code** (in any repo) read and edit tickets on a [Kando](https://kando.pnientiedt.de) board — so it can plan and work tasks tracked on a real Kanban board. Cross-platform (Windows, Linux, macOS), installed via `npx`.

> **Heads up — this connects to a shared, hosted Kando instance.**
> `kando-mcp` talks to the hosted Kando at **https://kando.pnientiedt.de**. When you use it, your boards and tickets live on that instance's infrastructure, under your own account. There is no self-hosting option today. Sign up (it's open) at the site, then log in below.

## Install

You need [Node.js 20+](https://nodejs.org). Then:

```bash
# 1. Log in once per machine (stores only a refresh token, never your password)
npx kando-mcp login

# 2. Wire it into a repo (run inside the repo you want to use it from)
npx kando-mcp init
```

Then **restart Claude Code** in that repo. Confirm it works by asking Claude to “list my Kando boards”.

`init` writes `.mcp.json` (pointing at `npx kando-mcp serve`), drops the `kando` skills/commands + a workflow hook into `.claude/`, and approves the server in `.claude/settings.local.json`. It never commits secrets.

## Authentication

`login` performs a one-time Amazon Cognito SRP sign-in and stores **only the refresh token** in your OS config dir:

| OS | Location |
|----|----------|
| Linux | `~/.config/kando/credentials.json` (or `$XDG_CONFIG_HOME/kando`) |
| macOS | `~/Library/Application Support/kando/credentials.json` |
| Windows | `%APPDATA%\kando\credentials.json` |

The token is valid for **90 days**; the server warns you when fewer than 5 days remain. Re-run `npx kando-mcp login` to refresh it, or `npx kando-mcp logout` to remove it.

### CI / advanced: environment overrides

`serve` resolves credentials in this order (first match wins):

1. `KANDO_REFRESH_TOKEN` — a refresh token, refresh-only.
2. `KANDO_EMAIL` + `KANDO_PASSWORD` — full SRP login each start.
3. The stored token from `kando-mcp login`.

Use the env vars for CI or a repo-scoped credential; they take precedence over the stored token.

## Authorization

Access is **per board**. The account you log in as only sees boards it is a member of — invite it (or be invited) as **EDITOR** to work a board, **VIEWER** for read-only. `kando-mcp` exposes no board/column/member admin: it is EDITOR-or-less by design.

## Tools

- **Read:** `list_boards`, `get_board`, `get_ticket`, `search_tickets`
- **Tickets:** `create_story`, `create_subtask`, `update_ticket`, `move_ticket`, `reorder_ticket`, `archive_ticket`, `unarchive_ticket`, `delete_ticket`
- **Comments:** `list_comments`, `add_comment`, `edit_comment`, `delete_comment`
- **Tags:** `create_tag`, `update_tag`, `delete_tag`
- **Releases:** `create_release`, `update_release`, `delete_release`
- **Loop:** `next_task`, `ensure_tag`

### Response shape

Responses are deliberately lean: **lists identify, `get_ticket` explains.** `get_board`
and `search_tickets` return `KEY-N`, title, column, tags and assignee — **never ticket
bodies** — and mutations return a short ack (`{"ticket":"TSK-42","col":"In Progress"}`)
rather than the whole object. `get_ticket` is the one tool that returns a body. On a real
60-ticket board that is ~2,800 tokens instead of ~163,000.

Nothing needs a UUID: columns, tags, releases and members are addressed by **label,
name and email**, plus `"me"` for the account you logged in as.

Boards are addressed by **key** (e.g. `TSK`); tickets by **`KEY-N`** (e.g. `TSK-42`). `move_ticket` changes a ticket's column (status); `reorder_ticket` changes its priority within its peer group — they're separate on purpose, so neither wipes the other.

A ticket can be **blocked by** other tickets on the same board. `get_ticket` reports
`blockedBy` (their `KEY-N`s) and `blocked: true` while any of them is unresolved;
whether a blocker still counts is resolved by Kando itself (Done, archived or deleted
stops blocking), so every tool agrees. `search_tickets` reports `blocked` on each row,
and `next_task` never returns a blocked ticket, nor the subtasks of a blocked container
story. Set one with `blockedBy` on
`update_ticket` / `create_story` / `create_subtask`; `[]` clears.

`search_tickets` searches **across boards** (omit `boards` for all of them), filtered
server-side: `tags` + `tagMode`, `releases`, `assignees` (`userSub` or `"me"`),
`columns`, `text`, `kind`, `archived` (`live`/`archived`/`all` — this replaces the old
`list_archived`), `snoozed`, `limit`. `truncated: true` means the result was cut off —
narrow it; there is no cursor.

Comments follow the same rule: **`TSK-42-3` is the third comment on `TSK-42`**, and that
key is all `edit_comment` and `delete_comment` need — no separate ticket argument. The
ordinal is never reused, so deleting `TSK-42-3` leaves a gap rather than renumbering the
comments after it, and a key you read stays valid.

`get_ticket` inlines a ticket's **10 most recent** comments — its own only, never a
subtask's — and reports `earlierComments` when there are more. `list_comments` returns
all of them.

The bundled `kando` skill treats the two as different things: **the body is the human's
spec, comments are the agent's record.** Claude posts its plan, its review findings and
what it changed as comments, and leaves the description you wrote alone.

## Pinning

`init` wires `npx -y kando-mcp serve`, which uses the latest published version. To pin, edit `.mcp.json` to `npx -y kando-mcp@0.1 serve` (or an exact version).

## Skills & commands

`init` installs the `kando`, `kando-refine`, and `kando-autonomous-loop` skills plus the `/kando-loop` and `/kando-refine` commands. See each skill for details; `/kando-loop` autonomously works tickets to completion and `/kando-refine` turns a ticket into a spec interactively.

`/kando-loop` works tickets **one at a time** but ships them **in batches**. Each ticket is implemented test-first, reviewed by an independent agent, and parked on a per-run `kando-loop/*` branch under a `pending-ship` tag. When a batch is worth deploying — normally a completed story, always before the run exits — the loop merges it to `main` and runs your full verification **once for the batch**. A story with ten subtasks therefore costs one deploy and one suite run, not ten. Only then do its tickets reach the last column. If a batch goes red, the loop fixes forward twice under the same review gate, and reverts the merge if that fails.

It verifies each shipped batch with **commands it composes by reading your repo** — GitHub Actions, GitLab CI, a `Makefile` target, or just your test suite. There is no CI configuration to write.

A background waiter (`.claude/hooks/kando-verify-wait.mjs`) runs them and reports the verdict through exit codes. It takes a **watch** (blocks until the outcome is known — the fast path) and/or a **probe** (polled status query — the safety net), and needs at least one. With both, whichever answers first wins, so a watch that hangs or dies can never strand the loop. A repo with no CI just gets a watch: its test suite runs to completion, however long it takes.

## Configuration & tests

Two committed configs, and the one the tests use is **not** the one the server uses. Both hold nothing but public ids — the same values any browser is served — and neither holds a credential.

| | `kando.config.json` | `kando.config.dev.json` |
|---|---|---|
| Stage | the hosted **production** Kando | the maintainer's **dev** stage |
| Read by | the installed server: `serve`, `login`, `init` — real work on your real boards | `src/live.e2e.test.ts` only; excluded from the published package |

They are separate on purpose: the stages differ only by opaque ids, so a test that inherited its target from the shipped config could run against production and still look green.

`npm test` runs the whole suite **offline** — no network, no account needed. The one test that talks to a real backend, `src/live.e2e.test.ts`, is skipped unless you opt in:

```bash
KANDO_LIVE=1 npx vitest run src/live.e2e.test.ts
```

It needs an account on the target stage. Put `KANDO_TEST_EMAIL` / `KANDO_TEST_PASSWORD` in the environment, or in a gitignored `.env.test.local` — copy `.env.test.local.example` and fill it in. Real environment variables win over the file, so CI supplies the same names as secrets with no code change.

**Targeting your own stage** instead of the dev default: set `KANDO_TEST_REGION`, `KANDO_TEST_POOL_ID`, `KANDO_TEST_CLIENT_ID`, and `KANDO_TEST_GRAPHQL_URL` — **all four or none**. A partial set is refused by name, because it would otherwise sign in to one stage's Cognito pool and write through another's API. As a backstop the resolver **refuses the production pool outright**, however it was supplied; `KANDO_ALLOW_PROD=1` overrides that, and you should not need it.

The test creates boards under random 8-letter keys and deletes them, which also frees the global `BOARDKEY#<KEY>` registry entry. That cleanup is asserted rather than assumed: one case deletes a board and then re-claims the same key, which only succeeds if the entry was really released. A failed delete fails the run loudly and names the board to remove by hand.

## License

MIT © 2026 Phillip Nientiedt
