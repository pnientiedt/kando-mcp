# Cross-board ticket search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild `search_tickets` on Kando's `getTickets` — server-side filtering across every board the bot can see — and retire `list_archived`.

**Architecture:** A new pure module `src/ticketSearch.ts` owns both mappings (tool input → wire filter, `TicketSummary` → lean row) and is tested without a server, like `shape.ts`. `src/tools/read.ts` becomes thin: resolve board keys → ids, one `gql(GET_TICKETS)`, shape the envelope. No `getBoard` call remains in the search path.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Zod input schemas, vitest, GraphQL operation strings hand-written in `src/operations.ts`.

**Spec:** `docs/superpowers/specs/2026-08-02-cross-board-ticket-search-design.md`

## Global Constraints

- **The backend query is `getTickets(filter: TicketFilter, limit: Int): TicketPage!`** (KDO-93, live in Dev and Prod).
- **Wire enums are UPPERCASE**, tool inputs are lowercase: `TagMode ANY|ALL`, `ArchivedFilter LIVE|ARCHIVED|ALL`, `SnoozedFilter HIDE|SHOW|ONLY`, `TicketKind STORY|SUBTASK`.
- **Server-side defaults, expressed by omission** — never send a field the caller did not set. The backend defaults `archived=LIVE`, `snoozed=SHOW`, `tagMode=ANY`, `limit=100`.
- **Server-side bounds:** `boardIds` ≤ 25, other lists ≤ 20, each entry ≤ 200 chars, `text` ≤ 200, `limit` 1–500. The backend **rejects** (`BAD_INPUT`) rather than clamping — the MCP does not pre-validate or clamp either.
- **Names, not ids:** `tags`/`releases`/`columns` are names/labels resolved **server-side, per board**. The MCP resolves only board **keys** → ids. `assignees` takes a raw `userSub` or `"me"` — never an email.
- **`TicketSummary` has no `body` and no `blockedBy`.** Bodies stay with `get_ticket`; the missing `blockedBy` is tracked as **KDO-96**.
- **Imports are ESM with a `.js` suffix** even for `.ts` files.
- **Every file under `skills/` has a byte-identical tracked mirror under `.claude/`.** Copy with `command cp` — plain `cp` is aliased to `cp -i` in this shell and will silently refuse.
- **Verification for every task:** `npm test` and `npm run typecheck` green before the commit.

---

## File Structure

**Created:**
- `src/ticketSearch.ts` — `buildTicketFilter` + `leanSummary`. Pure; no I/O, no GraphQL.
- `src/ticketSearch.test.ts` — both mappings.

**Modified:**
- `src/operations.ts` — `GET_TICKETS`.
- `src/graphql.ts` — a `TOO_BROAD` message.
- `src/graphql.test.ts` — assert it.
- `src/tools/read.ts` — `resolveBoardIds`; `search_tickets` rewritten; `list_archived` deleted.
- `src/tools/read.test.ts` — the `search_tickets is lean` block rewritten; `list_archived` tests deleted; a registration assertion added.
- `src/tools/tickets.ts` — `unarchive_ticket`'s description stops naming `list_archived`.
- `src/live.e2e.test.ts` — the archived assertion moves onto `search_tickets`.
- `README.md`, `skills/kando/SKILL.md` (+ `.claude/skills/kando/SKILL.md`).

---

### Task 1: The two mappings (`src/ticketSearch.ts`)

**Files:**
- Create: `src/ticketSearch.ts`, `src/ticketSearch.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  ```ts
  export type SearchInput = {
    tags?: string[]; tagMode?: 'any' | 'all'; releases?: string[]; assignees?: string[];
    columns?: string[]; text?: string; kind?: 'story' | 'subtask';
    archived?: 'live' | 'archived' | 'all'; snoozed?: 'show' | 'hide' | 'only';
  };
  export function buildTicketFilter(input: SearchInput, boardIds?: string[]): Record<string, unknown>;

  export type LeanRow = {
    ticket: string | null; title: string; col: string; parent?: string; tags?: string[];
    assignee?: string; snoozed?: boolean; release?: string; subtasks?: number; archivedAt?: string;
  };
  export function leanSummary(s: any): LeanRow;
  ```
  `buildTicketFilter` returns an object containing **only** the fields the caller set (an empty object when nothing was set); `leanSummary` maps one `TicketSummary` row.

- [ ] **Step 1: Write the failing test**

Create `src/ticketSearch.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildTicketFilter, leanSummary } from './ticketSearch.js';

describe('buildTicketFilter', () => {
  it('is empty when nothing was asked for — the server owns every default', () => {
    expect(buildTicketFilter({})).toEqual({});
  });

  it('uppercases the enums for the wire', () => {
    expect(
      buildTicketFilter({ kind: 'subtask', archived: 'all', snoozed: 'only', tagMode: 'all', tags: ['claude'] }),
    ).toEqual({ kind: 'SUBTASK', archived: 'ALL', snoozed: 'ONLY', tagMode: 'ALL', tags: ['claude'] });
  });

  it('passes names, "me" and free text through untouched', () => {
    expect(
      buildTicketFilter({
        tags: ['claude', 'refined'],
        releases: ['v1.0'],
        assignees: ['me', 'sub-123'],
        columns: ['In Progress'],
        text: 'deploy',
      }),
    ).toEqual({
      tags: ['claude', 'refined'],
      releases: ['v1.0'],
      assignees: ['me', 'sub-123'],
      columns: ['In Progress'],
      text: 'deploy',
    });
  });

  it('adds boardIds only when board ids were resolved', () => {
    expect(buildTicketFilter({}, ['b1', 'b2'])).toEqual({ boardIds: ['b1', 'b2'] });
    expect(buildTicketFilter({}, [])).toEqual({});
    expect(buildTicketFilter({})).toEqual({});
  });

  it('treats an empty list as "no filter", never as "match nothing"', () => {
    expect(buildTicketFilter({ tags: [], columns: [], assignees: [] })).toEqual({});
  });

  it('does not send tagMode on its own — it only qualifies tags', () => {
    expect(buildTicketFilter({ tagMode: 'all' })).toEqual({});
  });
});

describe('leanSummary', () => {
  const row = {
    ticket: 'KDO-12',
    parent: null,
    title: 'Batched deploys',
    columnLabel: 'In Progress',
    subtaskCount: 0,
    tags: ['claude'],
    releaseName: null,
    assignee: 'sub-1',
    assigneeEmail: 'bot@example.com',
    visibleAt: null,
    archivedAt: null,
  };

  it('keeps the identifying fields and drops every empty one', () => {
    expect(leanSummary(row)).toEqual({
      ticket: 'KDO-12',
      title: 'Batched deploys',
      col: 'In Progress',
      tags: ['claude'],
      assignee: 'bot@example.com',
    });
  });

  it('carries the parent for a subtask and the release when set', () => {
    expect(leanSummary({ ...row, parent: 'KDO-1', releaseName: 'v1.0' })).toMatchObject({
      parent: 'KDO-1',
      release: 'v1.0',
    });
  });

  it('marks a container with its live subtask count, never a standalone with 0', () => {
    expect(leanSummary({ ...row, subtaskCount: 3 }).subtasks).toBe(3);
    expect(leanSummary(row)).not.toHaveProperty('subtasks');
  });

  it('derives snoozed from a FUTURE visibleAt only', () => {
    expect(leanSummary({ ...row, visibleAt: '2999-01-01T00:00:00Z' }).snoozed).toBe(true);
    expect(leanSummary({ ...row, visibleAt: '2000-01-01T00:00:00Z' })).not.toHaveProperty('snoozed');
  });

  it('carries archivedAt — recency survives, since the sort no longer conveys it', () => {
    expect(leanSummary({ ...row, archivedAt: '2026-08-01T10:00:00Z' }).archivedAt).toBe(
      '2026-08-01T10:00:00Z',
    );
  });

  it('falls back to the raw sub when the server could not name the assignee', () => {
    expect(leanSummary({ ...row, assigneeEmail: null }).assignee).toBe('sub-1');
  });

  it('never carries a body — there is no body to carry', () => {
    expect(JSON.stringify(leanSummary({ ...row, body: 'SECRET SPEC' }))).not.toContain('SECRET');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/ticketSearch.test.ts`
Expected: FAIL — `Failed to resolve import "./ticketSearch.js"`.

- [ ] **Step 3: Write `src/ticketSearch.ts`**

```ts
/**
 * KDO-93 `getTickets`: the two mappings that stand between the tool's inputs and
 * the wire, and between a `TicketSummary` and a lean row. Pure — hand it plain
 * objects and it hands plain objects back, no server involved.
 *
 * Enums are lowercase at the tool boundary and UPPERCASE on the wire: the suite's
 * rule is that everything is addressed the way it is displayed, and `ARCHIVED` is
 * wire vocabulary.
 *
 * Nothing the caller did not set is ever sent. The defaults for `archived`,
 * `snoozed`, `tagMode` and `limit` live in the backend's `validate.ts` and
 * nowhere else, so they cannot drift out of step with a second copy here.
 */

export type SearchInput = {
  tags?: string[];
  tagMode?: 'any' | 'all';
  releases?: string[];
  assignees?: string[];
  columns?: string[];
  text?: string;
  kind?: 'story' | 'subtask';
  archived?: 'live' | 'archived' | 'all';
  snoozed?: 'show' | 'hide' | 'only';
};

/** An empty list means "no filter on this field" — never "match nothing". */
const list = (v: string[] | undefined): string[] | undefined => (v && v.length ? v : undefined);

export function buildTicketFilter(input: SearchInput, boardIds?: string[]): Record<string, unknown> {
  const f: Record<string, unknown> = {};
  const ids = list(boardIds);
  if (ids) f.boardIds = ids;
  const tags = list(input.tags);
  if (tags) {
    f.tags = tags;
    // tagMode qualifies `tags`; alone it would be a filter on nothing.
    if (input.tagMode) f.tagMode = input.tagMode.toUpperCase();
  }
  const releases = list(input.releases);
  if (releases) f.releases = releases;
  const assignees = list(input.assignees);
  if (assignees) f.assignees = assignees; // raw userSub or the "me" sentinel
  const columns = list(input.columns);
  if (columns) f.columns = columns;
  if (input.text) f.text = input.text;
  if (input.kind) f.kind = input.kind.toUpperCase();
  if (input.archived) f.archived = input.archived.toUpperCase();
  if (input.snoozed) f.snoozed = input.snoozed.toUpperCase();
  return f;
}

export type LeanRow = {
  ticket: string | null;
  title: string;
  col: string;
  parent?: string;
  tags?: string[];
  assignee?: string;
  snoozed?: boolean;
  release?: string;
  subtasks?: number;
  archivedAt?: string;
};

/**
 * One `TicketSummary` as a lean row, in the same vocabulary `leanItem` uses so a
 * search result reads like every other list. Empty fields are omitted rather than
 * emitted as null — across 100 rows the nulls cost more than the values.
 *
 * No board field: `ticket` is `KEY-N` and the key names the board, so a board
 * column would repeat itself on every row of a cross-board result.
 */
export function leanSummary(s: any): LeanRow {
  const out: LeanRow = { ticket: s.ticket ?? null, title: s.title, col: s.columnLabel };
  if (s.parent) out.parent = s.parent;
  if (s.tags?.length) out.tags = s.tags;
  const assignee = s.assigneeEmail ?? s.assignee;
  if (assignee) out.assignee = assignee;
  if (typeof s.visibleAt === 'string' && Date.parse(s.visibleAt) > Date.now()) out.snoozed = true;
  if (s.releaseName) out.release = s.releaseName;
  // >0 is what distinguishes a CONTAINER from a standalone — the difference
  // between moving the story and moving its subtasks.
  if (s.subtaskCount > 0) out.subtasks = s.subtaskCount;
  // The sort is by KEY-N, so recency is no longer conveyed by position.
  if (s.archivedAt) out.archivedAt = s.archivedAt;
  return out;
}
```

- [ ] **Step 4: Run the test — it must pass**

Run: `npx vitest run src/ticketSearch.test.ts`
Expected: PASS (15 tests).

- [ ] **Step 5: Full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: all green (nothing else consumes the module yet).

- [ ] **Step 6: Commit**

```bash
git add src/ticketSearch.ts src/ticketSearch.test.ts
git commit -m "feat(search): the getTickets filter and row mappings"
```

---

### Task 2: `search_tickets` on `getTickets`

**Files:**
- Modify: `src/operations.ts` (append after `ARCHIVED_ITEMS`), `src/graphql.ts:13-21` (`MESSAGES`), `src/tools/read.ts:111-120` (`resolveBoardId`) and `src/tools/read.ts:259-289` (`search_tickets`)
- Test: `src/graphql.test.ts`, `src/tools/read.test.ts:145-162`

**Interfaces:**
- Consumes: `buildTicketFilter`, `leanSummary`, `SearchInput` from `src/ticketSearch.js` (Task 1).
- Produces:
  ```ts
  // src/operations.ts
  export const GET_TICKETS: string;
  // src/tools/read.ts
  export async function resolveBoardIds(gql: Gql, boards: string[]): Promise<string[]>;
  ```
  `resolveBoardIds` translates board **keys** to ids with ONE `myBoards` read; a non-key string passes through as a raw id. `search_tickets` returns `{tickets: LeanRow[], truncated?: true, boards?: number}`.

- [ ] **Step 1: Write the failing tests**

In `src/tools/read.test.ts`, **replace the whole `describe('search_tickets is lean', ...)` block** (currently at line 145 — it stubs `getBoard`, which this tool no longer calls) with:

```ts
describe('search_tickets', () => {
  /** One `getTickets` page: a container story and a snoozed subtask. */
  const page = (over: Record<string, unknown> = {}) => ({
    getTickets: {
      items: [
        {
          ticket: 'KDO-1', parent: null, title: 'Container', columnLabel: 'Open', subtaskCount: 2,
          tags: ['claude'], releaseName: null, assignee: 'sub-1', assigneeEmail: 'bot@example.com',
          visibleAt: null, archivedAt: null,
        },
        {
          ticket: 'KDO-2', parent: 'KDO-1', title: 'Child', columnLabel: 'Open', subtaskCount: 0,
          tags: [], releaseName: null, assignee: null, assigneeEmail: null,
          visibleAt: '2999-01-01T00:00:00Z', archivedAt: null,
        },
      ],
      truncated: false,
      boardsSearched: 1,
      ...over,
    },
  });

  const capture = (data: any) => {
    const calls: Array<{ query: string; variables: any }> = [];
    const gql = vi.fn(async (query: string, variables: any) => {
      calls.push({ query, variables });
      if (query.includes('myBoards')) {
        return { myBoards: [{ id: 'b1', key: 'KDO' }, { id: 'b2', key: 'TSK' }] };
      }
      return data;
    });
    return { calls, gql };
  };

  it('queries getTickets once and never getBoard — the whole point of the rewrite', async () => {
    const { calls, gql } = capture(page());
    const { host, tools } = captureHost();
    registerReadTools(host, gql as never);

    const out = JSON.parse((await tools.search_tickets({})).content[0].text);

    expect(calls).toHaveLength(1);
    expect(calls[0].query).toContain('getTickets');
    expect(calls.some((c) => c.query.includes('getBoard'))).toBe(false);
    expect(out.tickets).toEqual([
      { ticket: 'KDO-1', title: 'Container', col: 'Open', tags: ['claude'], assignee: 'bot@example.com', subtasks: 2 },
      { ticket: 'KDO-2', title: 'Child', col: 'Open', parent: 'KDO-1', snoozed: true },
    ]);
  });

  it('sends no filter and no limit when nothing was asked for', async () => {
    const { calls, gql } = capture(page());
    const { host, tools } = captureHost();
    registerReadTools(host, gql as never);

    await tools.search_tickets({});
    expect(calls[0].variables).toEqual({});
  });

  it('resolves board KEYS to ids in one myBoards read', async () => {
    const { calls, gql } = capture(page());
    const { host, tools } = captureHost();
    registerReadTools(host, gql as never);

    await tools.search_tickets({ boards: ['KDO', 'TSK'] });
    expect(calls.filter((c) => c.query.includes('myBoards'))).toHaveLength(1);
    expect(calls.find((c) => c.query.includes('getTickets'))!.variables.filter.boardIds).toEqual(['b1', 'b2']);
  });

  it('maps the filters and limit onto the query', async () => {
    const { calls, gql } = capture(page());
    const { host, tools } = captureHost();
    registerReadTools(host, gql as never);

    await tools.search_tickets({ assignees: ['me'], archived: 'all', kind: 'story', limit: 5 });
    const q = calls.find((c) => c.query.includes('getTickets'))!;
    expect(q.variables).toEqual({
      filter: { assignees: ['me'], archived: 'ALL', kind: 'STORY' },
      limit: 5,
    });
  });

  it('reports truncation and the fan-out size, and stays silent when neither says anything', async () => {
    const { gql } = capture(page({ truncated: true, boardsSearched: 4 }));
    const { host, tools } = captureHost();
    registerReadTools(host, gql as never);
    const loud = JSON.parse((await tools.search_tickets({})).content[0].text);
    expect(loud.truncated).toBe(true);
    expect(loud.boards).toBe(4);

    const { gql: gql2 } = capture(page());
    const { host: host2, tools: tools2 } = captureHost();
    registerReadTools(host2, gql2 as never);
    const quiet = JSON.parse((await tools2.search_tickets({})).content[0].text);
    expect(quiet).not.toHaveProperty('truncated');
    expect(quiet).not.toHaveProperty('boards');
  });

  it('never returns a body', async () => {
    const { gql } = capture(page());
    const { host, tools } = captureHost();
    registerReadTools(host, gql as never);
    const text = (await tools.search_tickets({ text: 'XXX' })).content[0].text;
    expect(text).not.toContain('"body"');
  });
});
```

Also append to `src/graphql.test.ts`, inside the existing `mapErrorToken` describe (the one asserting `NOT_FOUND` at line 38):

```ts
    // A read that fanned out too far. Without an entry it fell through to the
    // write-shaped fallback ("the change was not saved"), which is wrong twice.
    expect(mapErrorToken('TOO_BROAD')).toMatch(/boards/i);
    expect(mapErrorToken('TOO_BROAD')).not.toMatch(/not saved/i);
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run src/tools/read.test.ts src/graphql.test.ts`
Expected: FAIL — `search_tickets` still requires `board` and calls `getBoard`; `TOO_BROAD` maps to the fallback.

- [ ] **Step 3: Add the operation**

Append to `src/operations.ts`, after `ARCHIVED_ITEMS`:

```ts
// KDO-93: cross-board, server-side filtered ticket search, built for this suite.
// The selection is exactly what a lean row needs: no `boardId`/`boardName` (the
// `KEY-N` names the board), no `columnId` (the label is what we show), no `kind`
// (`parent` and `subtaskCount` already say it), and there is no `body` to ask for.
export const GET_TICKETS = `
  query GetTickets($filter: TicketFilter, $limit: Int) {
    getTickets(filter: $filter, limit: $limit) {
      items {
        ticket parent title columnLabel subtaskCount
        tags releaseName assignee assigneeEmail visibleAt archivedAt
      }
      truncated
      boardsSearched
    }
  }`;
```

- [ ] **Step 4: Give `TOO_BROAD` a real message**

In `src/graphql.ts`, add to `MESSAGES`:

```ts
  TOO_BROAD:
    'That search covers too many boards. Name the boards you mean with `boards`, or narrow the filter.',
```

- [ ] **Step 5: Rewrite the tool**

In `src/tools/read.ts`:

1. Imports:
   ```ts
   import { MY_BOARDS, GET_BOARD, ARCHIVED_ITEMS, COMMENTS, GET_TICKETS } from '../operations.js';
   import { buildTicketFilter, leanSummary, type SearchInput } from '../ticketSearch.js';
   ```
2. Next to `resolveBoardId`, add the list form:
   ```ts
   /**
    * Board KEYS to ids for a whole list, in ONE `myBoards` read — `resolveBoardId`
    * per entry would pay for that read once per board. A value that is not a key
    * passes through as a raw id, same as the single form.
    */
   export async function resolveBoardIds(gql: Gql, boards: string[]): Promise<string[]> {
     if (!boards.some((b) => KEY_RE.test(b))) return boards;
     const data = await gql(MY_BOARDS);
     const byKey = new Map<string, string>((data.myBoards ?? []).map((b: any) => [b.key, b.id]));
     return boards.map((b) => {
       if (!KEY_RE.test(b)) return b;
       const id = byKey.get(b);
       if (!id) throw new KandoError(`No board with key "${b}" is visible to the bot.`, 'NOT_FOUND');
       return id;
     });
   }
   ```
3. Replace the whole `search_tickets` registration with:
   ```ts
   server.registerTool(
     'search_tickets',
     {
       description:
         'Search tickets ACROSS BOARDS, filtered server-side. Omit `boards` to search every board the bot ' +
         'can see. Filters combine with AND; tag/release/column names are matched per board, so one name ' +
         'works across all of them. Returns identifiers only — use get_ticket for a body (text still ' +
         'searches bodies). `truncated: true` means the result was cut off: narrow the query, there is no ' +
         'next page. A row with `subtasks: N` is a container story; move its subtasks, not the story.',
       inputSchema: {
         boards: z.array(z.string()).optional().describe('board keys or ids; omit to search every board (max 25)'),
         tags: z.array(z.string()).optional().describe('tag NAMES'),
         tagMode: z.enum(['any', 'all']).optional().describe('any (default) = has one of the tags; all = has every one'),
         releases: z.array(z.string()).optional().describe('release names'),
         assignees: z.array(z.string()).optional().describe('member userSubs, or "me"'),
         columns: z.array(z.string()).optional().describe('column labels or ids'),
         text: z.string().optional().describe('matches title + description'),
         kind: z.enum(['story', 'subtask']).optional(),
         archived: z.enum(['live', 'archived', 'all']).optional().describe('default live'),
         snoozed: z.enum(['show', 'hide', 'only']).optional().describe('default show — a search hides nothing'),
         limit: z.number().optional().describe('1-500, default 100'),
       },
     },
     async ({ boards, limit, ...f }) => {
       const boardIds = boards?.length ? await resolveBoardIds(gql, boards) : undefined;
       const filter = buildTicketFilter(f as SearchInput, boardIds);
       const variables: Record<string, unknown> = {};
       // Omitted, not null: the backend owns every default, and sending an empty
       // filter object would be a filter that says nothing.
       if (Object.keys(filter).length) variables.filter = filter;
       if (limit !== undefined) variables.limit = limit;
       const page = (await gql(GET_TICKETS, variables)).getTickets;
       const out: Record<string, unknown> = { tickets: (page.items ?? []).map(leanSummary) };
       if (page.truncated) out.truncated = true;
       // The fan-out size is worth saying only when it was a fan-out.
       if ((page.boardsSearched ?? 0) > 1) out.boards = page.boardsSearched;
       return toolText(out);
     },
   );
   ```

`registerReadTools` still takes `botEmail`; leave the parameter and the other tools' use of it alone.

- [ ] **Step 6: Run the tests — they must pass**

Run: `npx vitest run src/tools/read.test.ts src/graphql.test.ts`
Expected: PASS. If `botEmail` or `resolveAssignee`/`resolveTagIds`/`resolveReleaseId` is now unused in `read.ts`, remove only the imports that TypeScript reports as unused — `get_board`, `get_ticket` and `list_archived` still use `buildContext`/`flattenBoard`/`leanItem`.

- [ ] **Step 7: Full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add src/operations.ts src/graphql.ts src/graphql.test.ts src/tools/read.ts src/tools/read.test.ts
git commit -m "feat(search_tickets): cross-board, server-side filtered search"
```

---

### Task 3: Retire `list_archived` and teach the suite

**Files:**
- Modify: `src/tools/read.ts` (delete the `list_archived` registration), `src/tools/read.test.ts` (delete its tests, assert it is gone), `src/tools/tickets.ts:~330` (`unarchive_ticket`'s description), `src/live.e2e.test.ts:111-115`, `README.md:52`, `skills/kando/SKILL.md:107-115`
- Mirror: `.claude/skills/kando/SKILL.md`

**Interfaces:**
- Consumes: `search_tickets`'s new input/output from Task 2.
- Produces: nothing importable. The `list_archived` **tool** no longer exists; `ARCHIVED_ITEMS`, `archivedDetail` and `get_ticket`'s archived path are untouched.

- [ ] **Step 1: Write the failing test**

In `src/tools/read.test.ts`, delete any `describe`/`it` that calls `tools.list_archived`, and add:

```ts
describe('list_archived is retired', () => {
  it('is no longer registered — search_tickets archived:"archived" answers it', () => {
    const { host, tools } = captureHost();
    registerReadTools(host, (async () => ({})) as never);
    expect(tools.list_archived).toBeUndefined();
    expect(tools.search_tickets).toBeDefined();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/tools/read.test.ts`
Expected: FAIL — `expected [Function] to be undefined`.

- [ ] **Step 3: Delete the registration**

In `src/tools/read.ts`, remove the entire `server.registerTool('list_archived', …)` block (the last tool in `registerReadTools`). Keep `ARCHIVED_ITEMS` imported — `archivedDetail` still uses it. Remove any import left unused by the deletion, as reported by `npm run typecheck`.

- [ ] **Step 4: Run it — it must pass**

Run: `npx vitest run src/tools/read.test.ts`
Expected: PASS.

- [ ] **Step 5: Stop pointing at a tool that no longer exists**

In `src/tools/tickets.ts`, `unarchive_ticket`'s description ends `'…archived until unarchived by name (list_archived shows them).'`. Replace that parenthetical:

```ts
        'archived until unarchived by name (search_tickets with archived: "archived" lists them).',
```

- [ ] **Step 6: Move the live e2e assertion**

In `src/live.e2e.test.ts`, replace the `list_archived` block (currently lines 111–115):

```ts
    // archive it, then confirm it's in the archive and off the board
    await tools.archive_ticket({ ticket });
    const archRes = await tools.search_tickets({ boards: [boardKey], archived: 'archived' });
    const archived = JSON.parse(archRes.content[0].text);
    expect(archived.tickets.some((a: any) => a.ticket === ticket)).toBe(true);
    expect(archived.tickets.find((a: any) => a.ticket === ticket).archivedAt).toBeTruthy();
```

- [ ] **Step 7: Update the README**

`README.md` line 52 lists the read tools. Drop `list_archived`:

```markdown
- **Read:** `list_boards`, `get_board`, `get_ticket`, `search_tickets`
```

Then, in `### Response shape`, add one paragraph directly **after** the dependencies
paragraph added by the blockedBy work (the one beginning "A ticket can be **blocked
by**"). Change nothing else in that section:

```markdown
`search_tickets` searches **across boards** (omit `boards` for all of them), filtered
server-side: `tags` + `tagMode`, `releases`, `assignees` (`userSub` or `"me"`),
`columns`, `text`, `kind`, `archived` (`live`/`archived`/`all` — this replaces the old
`list_archived`), `snoozed`, `limit`. `truncated: true` means the result was cut off —
narrow it; there is no cursor.
```

- [ ] **Step 8: Rewrite the skill's "Finding work" section**

In `skills/kando/SKILL.md`, replace the single paragraph under `## Finding work` (currently line 109) with:

```markdown
`search_tickets` searches **across boards**, filtered server-side — omit `boards` and it
covers every board the bot can see. Filters combine with AND:

- `boards` (keys or ids), `tags` (NAMES) + `tagMode: "any"|"all"`, `releases`,
  `assignees` (`userSub` or `"me"`), `columns` (labels or ids), `text` (title +
  description), `kind: "story"|"subtask"`, `limit` (1–500, default 100).
- `archived: "live"` (default) `| "archived" | "all"` — `"archived"` is how you list the
  archive.
- `snoozed: "show"` (default) `| "hide" | "only"` — a search never hides a future-dated
  ticket unless you ask it to.

Tag, release and column names are matched **per board**, so one name means the right
thing on all of them at once. A row with `subtasks: N` is a **container** — move its
subtasks, not the story. `truncated: true` means the result was cut off: narrow the
query, there is no next page.

`get_board` gives one whole board when you need the full picture.
```

- [ ] **Step 9: Sync the mirror and verify it**

```bash
command cp skills/kando/SKILL.md .claude/skills/kando/SKILL.md
cmp -s skills/kando/SKILL.md .claude/skills/kando/SKILL.md && echo identical || echo DIFFERS
```
Expected: `identical`. (Plain `cp` is aliased to `cp -i` here and will refuse silently — use `command cp`.)

- [ ] **Step 10: Full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: all green.

- [ ] **Step 11: Prove it against the deployed schema**

Run: `KANDO_LIVE=1 npx vitest run src/live.e2e.test.ts`
Expected: PASS. This is the only check that the `TicketFilter` shape, the enum values and the field selection are actually accepted by AppSync — a stub cannot make that claim.

- [ ] **Step 12: Commit**

```bash
git add src/tools/read.ts src/tools/read.test.ts src/tools/tickets.ts src/live.e2e.test.ts README.md skills .claude/skills
git commit -m "feat(search): retire list_archived in favour of archived:\"archived\""
```

---

## Finishing

- [ ] `npm test && npm run typecheck` green, and the live e2e green against Dev.
- [ ] `git merge --no-ff list-tickets-api` onto `main`, then delete the branch (local and remote if pushed) — per `CLAUDE.md`.
- [ ] **Release.** `main` already carries the unreleased `blockedBy` work (v0.8.0 is the last tag), so **one `npm version minor` covers both** — new tool surface plus a removed tool. Confirm the number with the human, then `npm version minor -m "chore: release v%s"`, push `main` **and** the tag, and watch `gh run list --workflow publish.yml --limit 1` go green. **Do not push the tag without the human's go-ahead.** The release note must say `list_archived` is gone and name its replacement.
