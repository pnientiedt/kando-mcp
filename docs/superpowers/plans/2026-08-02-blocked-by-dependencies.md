# Blocking dependencies Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Teach the kando MCP suite about Kando's `blockedBy` dependencies — `next_task` never serves a ticket whose blockers are unresolved, `get_ticket` shows them, and the write tools can set them.

**Architecture:** One new pure module, `src/blocking.ts`, owns the single "is this blocker resolved?" rule and is consumed by `selectNextTask` (`src/tools/loop.ts`) and `get_ticket` (`src/tools/read.ts` → `src/shape.ts`). Writing goes through a new `resolveBlockedBy` in `src/resolve.ts`, beside the existing name→id resolvers, and rides the existing `TicketPatch` / `buildUpdateVars` path. Everything new is pure and tested without a server, matching how `shape.ts`, `rank.ts` and `reorder.ts` are already tested.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Zod input schemas, vitest, GraphQL operation strings hand-written in `src/operations.ts`.

**Spec:** `docs/superpowers/specs/2026-08-02-blocked-by-dependencies-design.md`

## Global Constraints

- **The backend field is `blockedBy: [ID!]!`** on `Story` and `Subtask` — ids of **same-board** items only. Mutation arguments are typed `[String!]` (nullable list, non-null members).
- **Resolved blocker rule (verbatim, used everywhere):** a blocker is resolved when it is **not found on the board** (archived or deleted) **or** it is **Done**. Done = its `columnId` is the board's last column (highest `order`); for a **container** blocker (≥1 live subtask) Done = **every live subtask** is in the last column. Anything else blocks.
- **Inheritance:** a subtask is blocked by its own `blockedBy` **and** by its parent container story's `blockedBy`.
- **Addressing:** every user-facing reference is `KEY-N`, never a UUID — the same contract as tags, releases, members and columns.
- **Imports are ESM with a `.js` suffix** even for `.ts` files (`import { x } from './blocking.js'`).
- **Every file under `skills/` and `agents/` has a byte-identical tracked mirror under `.claude/`.** Both copies change together; `cmp -s` must report them identical.
- **Verification for every task:** `npm test` and `npm run typecheck` both green before the commit.

---

## File Structure

**Created:**
- `src/blocking.ts` — the resolution rule + the two queries built on it. No I/O, no GraphQL.
- `src/blocking.test.ts` — the resolution matrix.

**Modified:**
- `src/operations.ts` — `blockedBy` in `storyFields` / `subtaskFields`; `$blockedBy` on the four create/update mutations.
- `src/operations.test.ts` — assert the read ops select it.
- `src/tools/loop.ts` — one clause in `selectNextTask`'s predicate; `next_task` description.
- `src/tools/loop.test.ts` — blocked / inherited / unblocked cases.
- `src/shape.ts` — `DetailOpts.blockers`, two fields on `leanDetail`'s output.
- `src/shape.test.ts` — the two fields render and are omitted when empty.
- `src/tools/read.ts` — compute the index in `get_ticket`, pass it to `leanDetail`.
- `src/tools/read.test.ts` — `get_ticket` reports `blockedBy` / `blocked`.
- `src/resolve.ts` — `resolveBlockedBy`.
- `src/resolve.test.ts` — KEY-N → id, unknown/off-board, `[]`, self-reference.
- `src/tools/tickets.ts` — `blockedBy` on `update_ticket`, `create_story`, `create_subtask`.
- `src/tools/tickets.test.ts` — the write path.
- `skills/kando/SKILL.md`, `skills/kando-refine/SKILL.md`, `skills/kando-autonomous-loop/SKILL.md` (+ `.claude/skills/**` mirrors), `README.md`.

---

### Task 1: The resolution rule (`src/blocking.ts`) + reading the field

**Files:**
- Create: `src/blocking.ts`, `src/blocking.test.ts`
- Modify: `src/operations.ts:6-13` (`subtaskFields`, `storyFields`), `src/operations.test.ts` (append a describe block)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  ```ts
  export type BlockerIndex = {
    /** item id -> its KEY-N (null when the board key or num is missing) */
    ticketOf: Map<string, string | null>;
    /** item ids that count as RESOLVED are absent from this set */
    unresolved: Set<string>;
    /** item id -> num, for sorting KEY-N output numerically */
    numOf: Map<string, number>;
  };
  export function buildBlockerIndex(bc: any): BlockerIndex;
  export function unresolvedBlockers(item: any, parent: any | null, index: BlockerIndex): string[];
  export function blockerTickets(item: any, index: BlockerIndex): string[];
  ```
  `unresolvedBlockers` returns the `KEY-N`s (sorted by num) of blockers that still block, taking the parent's blockers into account; `blockerTickets` returns every blocker of `item` alone that still exists on the board, sorted by num. Both return `[]` for an item with no `blockedBy`.

- [ ] **Step 1: Write the failing test**

Create `src/blocking.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildBlockerIndex, unresolvedBlockers, blockerTickets } from './blocking.js';

/**
 * Three columns; `c3` is Done. `s1` is an open standalone, `s2` a Done
 * standalone, `s3` a container whose subtasks are both Done, `s4` a container
 * with one subtask still open.
 */
function board() {
  return {
    board: {
      key: 'KDO',
      columns: [
        { id: 'c1', label: 'To Do', order: 0 },
        { id: 'c2', label: 'Doing', order: 1 },
        { id: 'c3', label: 'Done', order: 2 },
      ],
    },
    stories: [
      { id: 's1', num: 1, columnId: 'c1', blockedBy: [], subtasks: [] },
      { id: 's2', num: 2, columnId: 'c3', blockedBy: [], subtasks: [] },
      {
        id: 's3', num: 3, columnId: 'c2', blockedBy: [],
        subtasks: [
          { id: 'sub1', num: 4, columnId: 'c3', blockedBy: [] },
          { id: 'sub2', num: 5, columnId: 'c3', blockedBy: [] },
        ],
      },
      {
        id: 's4', num: 6, columnId: 'c2', blockedBy: [],
        subtasks: [
          { id: 'sub3', num: 7, columnId: 'c3', blockedBy: [] },
          { id: 'sub4', num: 8, columnId: 'c1', blockedBy: [] },
        ],
      },
    ],
  };
}

describe('buildBlockerIndex / unresolvedBlockers', () => {
  it('a blocker in the last column is resolved', () => {
    const i = buildBlockerIndex(board());
    expect(unresolvedBlockers({ id: 'x', blockedBy: ['s2'] }, null, i)).toEqual([]);
  });

  it('a blocker anywhere else blocks, named as KEY-N', () => {
    const i = buildBlockerIndex(board());
    expect(unresolvedBlockers({ id: 'x', blockedBy: ['s1'] }, null, i)).toEqual(['KDO-1']);
  });

  it('a blocker that is not on the board (archived or deleted) is resolved', () => {
    const i = buildBlockerIndex(board());
    expect(unresolvedBlockers({ id: 'x', blockedBy: ['gone'] }, null, i)).toEqual([]);
  });

  it('a container blocker is resolved only when EVERY live subtask is Done', () => {
    const i = buildBlockerIndex(board());
    expect(unresolvedBlockers({ id: 'x', blockedBy: ['s3'] }, null, i)).toEqual([]);
    expect(unresolvedBlockers({ id: 'x', blockedBy: ['s4'] }, null, i)).toEqual(['KDO-6']);
  });

  it('a subtask inherits its container story\'s blockers', () => {
    const i = buildBlockerIndex(board());
    const sub = { id: 'x', blockedBy: [] };
    const parent = { id: 's3', blockedBy: ['s1'] };
    expect(unresolvedBlockers(sub, parent, i)).toEqual(['KDO-1']);
  });

  it('reports own and inherited blockers together, sorted by num, de-duplicated', () => {
    const i = buildBlockerIndex(board());
    const out = unresolvedBlockers(
      { id: 'x', blockedBy: ['s4', 's1'] },
      { id: 's3', blockedBy: ['s1'] },
      i,
    );
    expect(out).toEqual(['KDO-1', 'KDO-6']);
  });

  it('is empty for an item with no blockedBy at all (pre-KDO-94 shape)', () => {
    const i = buildBlockerIndex(board());
    expect(unresolvedBlockers({ id: 'x' }, null, i)).toEqual([]);
    expect(blockerTickets({ id: 'x' }, i)).toEqual([]);
  });

  it('a board with no columns resolves nothing and blocks nothing', () => {
    const i = buildBlockerIndex({ board: { key: 'KDO', columns: [] }, stories: [] });
    expect(unresolvedBlockers({ id: 'x', blockedBy: ['s1'] }, null, i)).toEqual([]);
  });
});

describe('blockerTickets', () => {
  it('lists every LIVE blocker of the item itself, resolved or not, sorted by num', () => {
    const i = buildBlockerIndex(board());
    expect(blockerTickets({ id: 'x', blockedBy: ['s2', 'gone', 's1'] }, i)).toEqual(['KDO-1', 'KDO-2']);
  });

  it('does not inherit the parent\'s blockers — that is unresolvedBlockers\' job', () => {
    const i = buildBlockerIndex(board());
    expect(blockerTickets({ id: 'x', blockedBy: [] }, i)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/blocking.test.ts`
Expected: FAIL — `Failed to resolve import "./blocking.js"`.

- [ ] **Step 3: Write `src/blocking.ts`**

```ts
/**
 * Blocking dependencies (KDO-94). A story or subtask carries `blockedBy`: the
 * ids of SAME-BOARD items that must be finished first. Everything here is pure
 * — hand it a board container and it answers, no server involved.
 *
 * ONE rule, in `buildBlockerIndex`, decides whether a blocker still stands:
 *
 *   - absent from the board  -> RESOLVED. `getBoard` drops archived rows, and a
 *     hard delete cascade-strips inbound refs (the backend's `dependencies.ts`),
 *     so absent means archived or gone — neither stands in the way. This is the
 *     same guard the web UI applies before rendering a dependency chip.
 *   - in the LAST column     -> RESOLVED (Done).
 *   - anything else          -> it blocks.
 *
 * A CONTAINER blocker is judged by its subtasks, never by its own `columnId`:
 * a story with subtasks has no authoritative column of its own (its status is
 * derived), so Done means every live subtask sits in the last column — the
 * first branch of the backend's `deriveColumnId`. This is the only place the
 * MCP derives container status.
 */

export type BlockerIndex = {
  ticketOf: Map<string, string | null>;
  /** Blockers that still stand. Resolved ids are simply absent. */
  unresolved: Set<string>;
  numOf: Map<string, number>;
};

export function buildBlockerIndex(bc: any): BlockerIndex {
  const cols = [...(bc?.board?.columns ?? [])].sort((a: any, b: any) => a.order - b.order);
  const lastCol: string | null = cols.length ? cols[cols.length - 1].id : null;
  const key: string | null = bc?.board?.key ?? null;
  const ticketOf = new Map<string, string | null>();
  const numOf = new Map<string, number>();
  const unresolved = new Set<string>();

  const register = (item: any, done: boolean) => {
    ticketOf.set(item.id, key && typeof item.num === 'number' ? `${key}-${item.num}` : null);
    if (typeof item.num === 'number') numOf.set(item.id, item.num);
    if (!done) unresolved.add(item.id);
  };

  for (const s of bc?.stories ?? []) {
    const subs = (s.subtasks ?? []).filter((sub: any) => !sub.archivedAt);
    // A container is Done when every live subtask is; a standalone story by its
    // own column. `lastCol` is null only on a column-less board, where nothing
    // can be Done and equally nothing is worth blocking — treat all as resolved.
    const storyDone = lastCol == null
      ? true
      : subs.length
        ? subs.every((sub: any) => sub.columnId === lastCol)
        : s.columnId === lastCol;
    register(s, storyDone);
    for (const sub of subs) register(sub, lastCol == null ? true : sub.columnId === lastCol);
  }
  return { ticketOf, unresolved, numOf };
}

/** Sort ids by their ticket number and render them as KEY-N, dropping unknowns. */
function asTickets(ids: string[], index: BlockerIndex): string[] {
  return [...new Set(ids)]
    .filter((id) => index.ticketOf.has(id))
    .sort((a, b) => (index.numOf.get(a) ?? 0) - (index.numOf.get(b) ?? 0))
    .map((id) => index.ticketOf.get(id))
    .filter((t): t is string => t != null);
}

/**
 * The blockers still standing in the way of working `item`, as KEY-N.
 *
 * `parent` is the item's CONTAINER story (null for a standalone story) and its
 * blockers count as the subtask's own: work units are standalone stories and
 * subtasks — never a container itself — so a dependency drawn on a container
 * would otherwise mean nothing at all.
 */
export function unresolvedBlockers(item: any, parent: any | null, index: BlockerIndex): string[] {
  const ids = [...(item?.blockedBy ?? []), ...(parent?.blockedBy ?? [])];
  return asTickets(ids.filter((id) => index.unresolved.has(id)), index);
}

/**
 * Every blocker of `item` ITSELF that still exists on the board, resolved or
 * not — the ticket's record of what it was ordered behind. Inheritance is
 * deliberately not applied: this answers "what did someone link here?".
 */
export function blockerTickets(item: any, index: BlockerIndex): string[] {
  return asTickets([...(item?.blockedBy ?? [])], index);
}
```

- [ ] **Step 4: Run the test — it must pass**

Run: `npx vitest run src/blocking.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Select the field so the data actually arrives**

In `src/operations.ts`, add `blockedBy` to both field lists:

```ts
const subtaskFields = `
  id num boardId storyId title body tags columnId rank
  releaseId estimateHours excludedFromRelease visibleAt assignee creator archivedAt blockedBy`;

const storyFields = `
  id num boardId title body tags columnId rank
  releaseId estimateHours visibleAt assignee creator archivedAt blockedBy
  subtasks { ${subtaskFields} }`;
```

- [ ] **Step 6: Guard the selection with a test**

Append to `src/operations.test.ts`:

```ts
// KDO-94 blocking dependencies. `blockedBy` must be SELECTED in every read op
// whose data reaches a caller as a ticket: next_task's eligibility check and
// get_ticket's detail are both built on it, and an unselected field reads as
// "nothing blocks this" — which is the exact wrong answer.
describe('MCP read selections surface blockedBy', () => {
  for (const [name, op] of Object.entries({ GET_BOARD, ARCHIVED_ITEMS })) {
    it(`${name} selects blockedBy`, () => {
      expect(op).toContain('blockedBy');
    });
  }
});
```

- [ ] **Step 7: Run the full suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add src/blocking.ts src/blocking.test.ts src/operations.ts src/operations.test.ts
git commit -m "feat(blocking): the blocker resolution rule, and read blockedBy"
```

---

### Task 2: `next_task` skips blocked tickets

**Files:**
- Modify: `src/tools/loop.ts:104-140` (`selectNextTask`), `src/tools/loop.ts:164-176` (`next_task` description)
- Test: `src/tools/loop.test.ts`

**Interfaces:**
- Consumes: `buildBlockerIndex`, `unresolvedBlockers` from `src/blocking.js` (Task 1).
- Produces: no new exports. `selectNextTask(bc, scope, botSub)` keeps its signature and return type.

- [ ] **Step 1: Write the failing tests**

Append to `src/tools/loop.test.ts`, inside the existing `describe('selectNextTask', ...)` block (the shared `board` fixture is defined just above it at `src/tools/loop.test.ts:62`):

```ts
  it('skips a unit whose own blocker is not Done', () => {
    // s1 (TSK-1) is blocked by s5, a container with an open subtask; the next
    // eligible unit is TSK-6, s5's own subtask.
    const blocked = {
      ...board,
      stories: [{ ...board.stories[0], blockedBy: ['s5'] }, board.stories[4]],
    };
    expect(selectNextTask(blocked, { kind: 'board' }, 'bot')?.ticket).toBe('TSK-6');
  });

  it('serves the unit once its blocker reaches the last column', () => {
    // s2 (TSK-2) is the Done standalone in the fixture.
    const unblocked = { ...board, stories: [{ ...board.stories[0], blockedBy: ['s2'] }] };
    expect(selectNextTask(unblocked, { kind: 'board' }, 'bot')?.ticket).toBe('TSK-1');
  });

  it('treats a blocker that is no longer on the board as resolved', () => {
    const ghost = { ...board, stories: [{ ...board.stories[0], blockedBy: ['gone'] }] };
    expect(selectNextTask(ghost, { kind: 'board' }, 'bot')?.ticket).toBe('TSK-1');
  });

  it('skips a subtask whose CONTAINER is blocked', () => {
    // s5's subtask TSK-6 is workable, but s5 itself waits on the open s1.
    const blockedContainer = {
      ...board,
      stories: [board.stories[0], { ...board.stories[4], blockedBy: ['s1'] }],
    };
    // TSK-1 is still free; it is the container's subtask that must not be served.
    const picked = selectNextTask(blockedContainer, { kind: 'board' }, 'bot');
    expect(picked?.ticket).toBe('TSK-1');
    expect(selectNextTask(blockedContainer, { kind: 'story', storyId: 's5' }, 'bot')).toBeNull();
  });

  it('returns null for a directly-targeted subtask that is blocked', () => {
    const blockedSub = {
      ...board,
      stories: [
        board.stories[0],
        {
          ...board.stories[4],
          subtasks: [{ ...board.stories[4].subtasks[0], blockedBy: ['s1'] }],
        },
      ],
    };
    const scope = { kind: 'subtask' as const, storyId: 's5', subtaskId: 'sub1' };
    expect(selectNextTask(blockedSub, scope, 'bot')).toBeNull();
  });
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run src/tools/loop.test.ts`
Expected: FAIL — the blocked cases still return the blocked ticket (e.g. `expected 'TSK-1' to be 'TSK-6'`).

- [ ] **Step 3: Add the clause**

In `src/tools/loop.ts`, import the module and extend the predicate. The `find` callback currently destructures only `{ item }` — it needs `kind` and `story` too:

```ts
import { buildBlockerIndex, unresolvedBlockers } from '../blocking.js';
```

```ts
  const blockers = buildBlockerIndex(bc);

  const top = unitsFor(bc, scope, cols[0].id).find(({ kind, story, item }) => {
    if (item.columnId === lastCol) return false; // Done
    if (typeof item.visibleAt === 'string' && Date.parse(item.visibleAt) > now) return false; // snoozed
    if (hnId && (item.tags ?? []).includes(hnId)) return false; // human-needed
    if (psId && (item.tags ?? []).includes(psId)) return false; // on the loop branch, awaiting a flush
    const a = item.assignee ?? null;
    if (a && a !== botSub) return false; // assigned to a human
    // KDO-94: a prerequisite that is not Done (or gone) means this is not
    // workable yet. A subtask also inherits its CONTAINER's blockers — work
    // units are never containers, so a dependency drawn on one would otherwise
    // have no effect at all. Applied in the shared predicate, so it holds at
    // board, story and single-subtask scope alike: a blocked ticket is not
    // workable, and how you asked for it does not change that.
    if (unresolvedBlockers(item, kind === 'subtask' ? story : null, blockers).length) return false;
    return true;
  });
```

- [ ] **Step 4: Run the tests — they must pass**

Run: `npx vitest run src/tools/loop.test.ts`
Expected: PASS, including every pre-existing case.

- [ ] **Step 5: Update the tool description**

In `src/tools/loop.ts`, in `next_task`'s `description`, change the skip sentence and add the dependency sentence:

```ts
        'Skips Done, snoozed, human-needed, pending-ship, blocked, and tickets assigned to a human. ' +
        'BLOCKED means an unresolved blockedBy dependency — a blocker counts as resolved once it is Done or off the board ' +
        '(archived/deleted); a subtask is also blocked while its container story is. ' +
```

- [ ] **Step 6: Full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/tools/loop.ts src/tools/loop.test.ts
git commit -m "feat(next_task): never serve a ticket with unresolved blockers"
```

---

### Task 3: `get_ticket` reports the dependency

**Files:**
- Modify: `src/shape.ts:63-95` (`DetailOpts`, `leanDetail`), `src/tools/read.ts:200-257` (`get_ticket`)
- Test: `src/shape.test.ts`, `src/tools/read.test.ts`

**Interfaces:**
- Consumes: `buildBlockerIndex`, `unresolvedBlockers`, `blockerTickets` from `src/blocking.js` (Task 1).
- Produces: `DetailOpts` gains `blockers?: { list: string[]; blocked: boolean }`. `leanDetail`'s output gains `blockedBy?: string[]` (omitted when the list is empty) and `blocked?: true` (omitted when false).

- [ ] **Step 1: Write the failing shape test**

Append inside `describe('leanDetail', ...)` in `src/shape.test.ts` (the shared `raw` fixture is at `src/shape.test.ts:91`):

```ts
  it('names the blockers and flags an unresolved one', () => {
    const d = leanDetail(raw, buildContext(bc()), {
      kind: 'story',
      ticket: 'KDO-1',
      columnLabel: 'Open',
      blockers: { list: ['KDO-7', 'KDO-9'], blocked: true },
    });
    expect(d.blockedBy).toEqual(['KDO-7', 'KDO-9']);
    expect(d.blocked).toBe(true);
  });

  it('keeps a resolved dependency listed but drops the blocked flag', () => {
    // The association is part of the record: KDO-7 being Done is not a reason
    // to forget the ticket was ordered behind it.
    const d = leanDetail(raw, buildContext(bc()), {
      kind: 'story',
      ticket: 'KDO-1',
      columnLabel: 'Open',
      blockers: { list: ['KDO-7'], blocked: false },
    });
    expect(d.blockedBy).toEqual(['KDO-7']);
    expect(d).not.toHaveProperty('blocked');
  });

  it('emits neither field when there are no dependencies', () => {
    const d = leanDetail(raw, buildContext(bc()), {
      kind: 'story',
      ticket: 'KDO-1',
      columnLabel: 'Open',
      blockers: { list: [], blocked: false },
    });
    expect(d).not.toHaveProperty('blockedBy');
    expect(d).not.toHaveProperty('blocked');
  });
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/shape.test.ts`
Expected: FAIL — TypeScript rejects the unknown `blockers` property / `d.blockedBy` is `undefined`.

- [ ] **Step 3: Extend `leanDetail`**

In `src/shape.ts`:

```ts
export type DetailOpts = {
  kind: 'story' | 'subtask';
  ticket: string | null;
  columnLabel: string;
  parent?: string;
  subtasks?: FlatItem[];
  /**
   * KDO-94 dependencies, already resolved to KEY-N by the caller (which holds
   * the board): `list` is every blocker still on the board, `blocked` says at
   * least one of them is not Done. Shaping stays free of board traversal.
   */
  blockers?: { list: string[]; blocked: boolean };
};
```

and, in `leanDetail`, after the `visibleAt` line and before `excludedFromRelease`:

```ts
  // Listed even when resolved — the association is part of the ticket's record.
  // `blocked` is the diagnostic: it is exactly why next_task passed this over.
  if (o.blockers?.list.length) out.blockedBy = o.blockers.list;
  if (o.blockers?.blocked) out.blocked = true;
```

- [ ] **Step 4: Run it — it must pass**

Run: `npx vitest run src/shape.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing wiring test**

Append to `src/tools/read.test.ts` (follow the file's existing `get_ticket` describe block for the gql stub shape — it stubs `resolveTicket`, `getBoard` and `comments`):

```ts
describe('get_ticket dependencies', () => {
  const boardWithBlockers = {
    getBoard: {
      board: {
        key: 'KDO',
        columns: [
          { id: 'c1', label: 'Open', order: 0 },
          { id: 'c2', label: 'Done', order: 1 },
        ],
      },
      tags: [],
      releases: [],
      members: [],
      stories: [
        { id: 's1', num: 1, title: 'Blocked one', body: 'B', columnId: 'c1', tags: [], blockedBy: ['s2', 's3'], subtasks: [] },
        { id: 's2', num: 2, title: 'Open blocker', columnId: 'c1', tags: [], blockedBy: [], subtasks: [] },
        { id: 's3', num: 3, title: 'Done blocker', columnId: 'c2', tags: [], blockedBy: [], subtasks: [] },
      ],
    },
  };

  const stub = () =>
    vi.fn(async (query: string) => {
      if (query.includes('resolveTicket')) {
        return { resolveTicket: { boardId: 'b1', storyId: 's1', subtaskId: null, archived: false } };
      }
      if (query.includes('comments')) return { comments: [] };
      return boardWithBlockers;
    });

  it('lists both blockers and flags the ticket blocked while one is open', async () => {
    const { host, tools } = captureHost();
    registerReadTools(host, stub() as never);
    const out = JSON.parse((await tools.get_ticket({ ticket: 'KDO-1' })).content[0].text);
    expect(out.blockedBy).toEqual(['KDO-2', 'KDO-3']);
    expect(out.blocked).toBe(true);
  });

  it('drops the flag once every blocker is Done', async () => {
    const done = structuredClone(boardWithBlockers);
    done.getBoard.stories[1].columnId = 'c2';
    const gql = vi.fn(async (query: string) => {
      if (query.includes('resolveTicket')) {
        return { resolveTicket: { boardId: 'b1', storyId: 's1', subtaskId: null, archived: false } };
      }
      if (query.includes('comments')) return { comments: [] };
      return done;
    });
    const { host, tools } = captureHost();
    registerReadTools(host, gql as never);
    const out = JSON.parse((await tools.get_ticket({ ticket: 'KDO-1' })).content[0].text);
    expect(out.blockedBy).toEqual(['KDO-2', 'KDO-3']);
    expect(out).not.toHaveProperty('blocked');
  });
});
```

If `captureHost` / `registerReadTools` are imported under different local names at the top of `src/tools/read.test.ts`, reuse that file's names rather than adding a second helper.

- [ ] **Step 6: Run it and watch it fail**

Run: `npx vitest run src/tools/read.test.ts`
Expected: FAIL — `out.blockedBy` is `undefined`.

- [ ] **Step 7: Wire it in `get_ticket`**

In `src/tools/read.ts`, import the module:

```ts
import { buildBlockerIndex, unresolvedBlockers, blockerTickets } from '../blocking.js';
```

then, after `const ctx = buildContext(bc);` inside `get_ticket`, build the index once and a small helper, and pass `blockers` into both `leanDetail` calls:

```ts
      const bIndex = buildBlockerIndex(bc);
      // A subtask inherits its container's blockers for the `blocked` verdict —
      // the same rule next_task applies — but `blockedBy` names only its own,
      // which is what somebody actually linked to this ticket.
      const blockersFor = (raw: any, parent: any | null) => ({
        list: blockerTickets(raw, bIndex),
        blocked: unresolvedBlockers(raw, parent, bIndex).length > 0,
      });
```

- subtask branch: `blockers: blockersFor(sub, story),`
- story branch: `blockers: blockersFor(story, null),`

Leave `archivedDetail` alone: an archived ticket is off the board, its blockers cannot be judged against it, and nothing schedules work from it.

- [ ] **Step 8: Run the tests — they must pass**

Run: `npx vitest run src/tools/read.test.ts src/shape.test.ts`
Expected: PASS.

- [ ] **Step 9: Full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: all green.

- [ ] **Step 10: Commit**

```bash
git add src/shape.ts src/shape.test.ts src/tools/read.ts src/tools/read.test.ts
git commit -m "feat(get_ticket): report blockedBy and whether the ticket is blocked"
```

---

### Task 4: Setting dependencies from the write tools

**Files:**
- Modify: `src/operations.ts:58-107` (the four create/update mutations), `src/resolve.ts` (append), `src/tools/tickets.ts:22-51` (`TicketPatch`, `buildUpdateVars`), `src/tools/tickets.ts:58-106` (`resolvePatch`, `createVars`), `src/tools/tickets.ts:131-229` (the three tools' schemas)
- Test: `src/resolve.test.ts`, `src/tools/tickets.test.ts`

**Interfaces:**
- Consumes: nothing from Tasks 1–3 (this is the write path).
- Produces:
  ```ts
  // src/resolve.ts
  export function resolveBlockedBy(bc: any, values: string[], selfTicket?: string): string[];
  ```
  Takes `KEY-N`s (or raw ids, passed through when they name a board item), returns item ids. `[]` in → `[]` out. Throws `KandoError('BAD_INPUT')` for a `KEY-N` that names nothing on this board, and for `selfTicket` appearing in `values`.
  `TicketPatch` gains `blockedBy?: string[]`; `buildUpdateVars` forwards it as the `blockedBy` variable when present.

- [ ] **Step 1: Write the failing resolver test**

Append to `src/resolve.test.ts` (reuse the file's existing board fixture if it has one; otherwise add this local one):

```ts
describe('resolveBlockedBy', () => {
  const bc = {
    board: { key: 'KDO', columns: [{ id: 'c1', label: 'Open', order: 0 }] },
    stories: [
      { id: 's1', num: 1, subtasks: [{ id: 'sub1', num: 2 }] },
      { id: 's2', num: 3, subtasks: [] },
    ],
  };

  it('turns KEY-N into ids, for stories and subtasks alike', () => {
    expect(resolveBlockedBy(bc, ['KDO-1', 'KDO-2'])).toEqual(['s1', 'sub1']);
  });

  it('is case-insensitive on the key', () => {
    expect(resolveBlockedBy(bc, ['kdo-3'])).toEqual(['s2']);
  });

  it('passes a raw id through when it names a board item', () => {
    expect(resolveBlockedBy(bc, ['sub1'])).toEqual(['sub1']);
  });

  it('clears with an empty list', () => {
    expect(resolveBlockedBy(bc, [])).toEqual([]);
  });

  it('refuses a ticket that is not on this board — dependencies are same-board', () => {
    expect(() => resolveBlockedBy(bc, ['KDO-99'])).toThrow(/KDO-99/);
    expect(() => resolveBlockedBy(bc, ['OTHER-1'])).toThrow(/same board/i);
  });

  it('refuses a self-reference', () => {
    expect(() => resolveBlockedBy(bc, ['KDO-1'], 'KDO-1')).toThrow(/itself/i);
  });
});
```

Add `resolveBlockedBy` to the import at the top of `src/resolve.test.ts`.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/resolve.test.ts`
Expected: FAIL — `resolveBlockedBy is not a function` / no exported member.

- [ ] **Step 3: Write `resolveBlockedBy`**

Append to `src/resolve.ts`:

```ts
/**
 * Blocking dependencies (KDO-94), addressed as KEY-N like everything else. A
 * raw item id passes through when it names something on this board, so an id
 * read back out of a ticket can be handed straight back in.
 *
 * Dependencies are SAME-BOARD by construction — the backend stores bare ids
 * with no board — so a KEY-N this board does not contain is refused rather
 * than stored as a reference that can never resolve. An empty list clears
 * every dependency; that is a list's own natural "none", unlike the ''-clears
 * convention the scalar fields use.
 */
export function resolveBlockedBy(bc: any, values: string[], selfTicket?: string): string[] {
  const key: string | null = bc?.board?.key ?? null;
  const items: Array<{ id: string; num: unknown }> = [];
  for (const s of bc?.stories ?? []) {
    items.push({ id: s.id, num: s.num });
    for (const sub of s.subtasks ?? []) items.push({ id: sub.id, num: sub.num });
  }
  const self = selfTicket?.toUpperCase();
  return values.map((v) => {
    const raw = v.trim();
    if (self && raw.toUpperCase() === self) {
      throw bad(`${raw} cannot be blocked by itself.`);
    }
    const byId = items.find((i) => i.id === raw);
    if (byId) return byId.id;
    const m = raw.match(/^([A-Za-z]{1,10})-(\d+)$/);
    if (!m) throw bad(`"${raw}" is not a ticket id (expected KEY-N, e.g. KDO-7).`);
    if (key && m[1].toUpperCase() !== key.toUpperCase()) {
      throw bad(`${raw} is not on this board (${key}). A blockedBy dependency must be on the same board.`);
    }
    const hit = items.find((i) => i.num === Number(m[2]));
    if (!hit) throw bad(`No ticket ${raw} on this board. A blockedBy dependency must be on the same board.`);
    return hit.id;
  });
}
```

- [ ] **Step 4: Run it — it must pass**

Run: `npx vitest run src/resolve.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing write-path tests**

Append to `src/tools/tickets.test.ts`. The first goes inside `describe('buildUpdateVars', ...)`:

```ts
  it('forwards blockedBy when provided, including the empty clear', () => {
    expect(buildUpdateVars({ boardId: 'b1', storyId: 's1' }, { blockedBy: ['s2'] }).variables)
      .toEqual({ boardId: 'b1', storyId: 's1', blockedBy: ['s2'] });
    expect(buildUpdateVars({ boardId: 'b1', storyId: 's1' }, { blockedBy: [] }).variables)
      .toEqual({ boardId: 'b1', storyId: 's1', blockedBy: [] });
  });
```

and these as a new top-level describe:

```ts
describe('blockedBy on the write tools', () => {
  /** KDO-1 (s1) and KDO-2 (s2), both standalone, in the single `open` column. */
  const board = {
    getBoard: {
      board: { id: 'b1', key: 'KDO', columns: [{ id: 'open', label: 'Open', order: 0 }] },
      tags: [],
      releases: [],
      members: [],
      stories: [
        { id: 's1', num: 1, columnId: 'open', rank: 'b', archivedAt: null, subtasks: [] },
        { id: 's2', num: 2, columnId: 'open', rank: 'd', archivedAt: null, subtasks: [] },
      ],
    },
  };

  function gqlStub(calls: Array<{ query: string; variables: any }>) {
    return vi.fn(async (query: string, variables: any) => {
      calls.push({ query, variables });
      if (query.includes('resolveTicket')) {
        return { resolveTicket: { boardId: 'b1', storyId: 's1', subtaskId: null, archived: false } };
      }
      if (query.includes('getBoard')) return board;
      if (query.includes('createStory')) return { createStory: { story: { id: 's3', num: 3 } } };
      if (query.includes('createSubtask')) return { createSubtask: { subtask: { id: 'sub1', num: 4 } } };
      return { updateStory: { story: { id: 's1' } } };
    });
  }

  it('update_ticket resolves KEY-N to an id and sends it', async () => {
    const calls: Array<{ query: string; variables: any }> = [];
    const { host, tools } = captureHost();
    registerTicketTools(host, gqlStub(calls) as never);

    const res = JSON.parse((await tools.update_ticket({ ticket: 'KDO-1', blockedBy: ['KDO-2'] })).content[0].text);
    const update = calls.find((c) => c.query.includes('updateStory'));
    expect(update!.variables.blockedBy).toEqual(['s2']);
    expect(res.updated).toContain('blockedBy');
  });

  it('update_ticket clears with an empty list', async () => {
    const calls: Array<{ query: string; variables: any }> = [];
    const { host, tools } = captureHost();
    registerTicketTools(host, gqlStub(calls) as never);

    await tools.update_ticket({ ticket: 'KDO-1', blockedBy: [] });
    expect(calls.find((c) => c.query.includes('updateStory'))!.variables.blockedBy).toEqual([]);
  });

  it('update_ticket refuses a self-reference', async () => {
    const { host, tools } = captureHost();
    registerTicketTools(host, gqlStub([]) as never);
    await expect(tools.update_ticket({ ticket: 'KDO-1', blockedBy: ['KDO-1'] })).rejects.toThrow(/itself/i);
  });

  it('create_story and create_subtask accept blockedBy', async () => {
    const calls: Array<{ query: string; variables: any }> = [];
    const { host, tools } = captureHost();
    registerTicketTools(host, gqlStub(calls) as never);

    await tools.create_story({ board: 'b1', title: 'New', blockedBy: ['KDO-2'] });
    expect(calls.find((c) => c.query.includes('createStory'))!.variables.blockedBy).toEqual(['s2']);

    await tools.create_subtask({ parent: 'KDO-1', title: 'Sub', blockedBy: ['KDO-2'] });
    expect(calls.find((c) => c.query.includes('createSubtask'))!.variables.blockedBy).toEqual(['s2']);
  });

  it('sends no blockedBy at all when the caller did not ask for one', async () => {
    const calls: Array<{ query: string; variables: any }> = [];
    const { host, tools } = captureHost();
    registerTicketTools(host, gqlStub(calls) as never);

    await tools.update_ticket({ ticket: 'KDO-1', title: 'Renamed' });
    expect(calls.find((c) => c.query.includes('updateStory'))!.variables).not.toHaveProperty('blockedBy');
  });

  it('advertises blockedBy on all three write tools', () => {
    const { host, configs } = captureHost();
    registerTicketTools(host, vi.fn() as never);
    for (const name of ['update_ticket', 'create_story', 'create_subtask']) {
      expect(configs[name].inputSchema).toHaveProperty('blockedBy');
    }
  });
});
```

- [ ] **Step 6: Run them and watch them fail**

Run: `npx vitest run src/tools/tickets.test.ts`
Expected: FAIL — `blockedBy` is absent from the variables and from the schemas.

- [ ] **Step 7: Thread `$blockedBy` through the mutations**

In `src/operations.ts`, add the argument to the four operations — declaration and call site both:

```ts
export const CREATE_STORY = `
  mutation ($boardId: ID!, $title: String!, $columnId: ID!, $body: String,
    $tags: [String!], $releaseId: String, $estimateHours: Float, $visibleAt: String, $assignee: String,
    $blockedBy: [String!]) {
    createStory(boardId: $boardId, title: $title, columnId: $columnId, body: $body,
      tags: $tags, releaseId: $releaseId, estimateHours: $estimateHours,
      visibleAt: $visibleAt, assignee: $assignee, blockedBy: $blockedBy) { ${storyChange} }
  }`;
```

and the same shape for `UPDATE_STORY`, `CREATE_SUBTASK`, `UPDATE_SUBTASK` — append `$blockedBy: [String!]` to the variable list and `blockedBy: $blockedBy` to the field arguments. The ack selections stay as they are.

- [ ] **Step 8: Carry it through the ticket tools**

In `src/tools/tickets.ts`:

1. `TicketPatch` gains `blockedBy?: string[];`.
2. In `buildUpdateVars`, next to the other optional fields:
   ```ts
   if (patch.blockedBy !== undefined) v.blockedBy = patch.blockedBy; // [] clears
   ```
3. In `resolvePatch`, extend the `needs` guard and resolve it. `resolvePatch` needs the ticket key to refuse a self-reference, so give it one more parameter:
   ```ts
   async function resolvePatch(
     gql: Gql,
     boardId: string,
     patch: TicketPatch,
     botEmail: string | null,
     selfTicket?: string,
   ): Promise<{ patch: TicketPatch; colLabel?: string }> {
     const needs =
       patch.column !== undefined ||
       patch.tags !== undefined ||
       patch.blockedBy !== undefined ||
       (patch.assignee !== undefined && patch.assignee !== '') ||
       (patch.releaseId !== undefined && patch.releaseId !== '');
     ...
     if (patch.blockedBy !== undefined) out.blockedBy = resolveBlockedBy(bc, patch.blockedBy, selfTicket);
   ```
   `update_ticket` passes its `ticket` as `selfTicket`; `move_ticket`'s existing call keeps its four arguments unchanged.
4. In `createVars`, beside the tag/assignee/release resolution:
   ```ts
   if (rest.blockedBy !== undefined) vars.blockedBy = resolveBlockedBy(bc, rest.blockedBy);
   ```
   (A brand-new ticket has no id yet, so no self-reference is possible.)
5. Import it: `import { resolveColumnId, resolveTagIds, resolveReleaseId, resolveAssignee, resolveBlockedBy } from '../resolve.js';`
6. Add the input to all three schemas — the same `describe` text on each:
   ```ts
   blockedBy: z
     .array(z.string())
     .optional()
     .describe('ticket KEY-Ns on the SAME board that must be Done first; [] clears them'),
   ```
   `create_story`'s and `create_subtask`'s schemas take it alongside `tags`; `patchShape` takes it for `update_ticket`.
7. Extend `update_ticket`'s description so the surface is discoverable:
   ```ts
   description: 'Edit a ticket (title/body/tags/assignee/release/estimate/snooze/column/blockedBy).',
   ```

- [ ] **Step 9: Run the tests — they must pass**

Run: `npx vitest run src/tools/tickets.test.ts src/resolve.test.ts`
Expected: PASS.

- [ ] **Step 10: Full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: all green.

- [ ] **Step 11: Commit**

```bash
git add src/operations.ts src/resolve.ts src/resolve.test.ts src/tools/tickets.ts src/tools/tickets.test.ts
git commit -m "feat(tickets): set and clear blockedBy by KEY-N"
```

---

### Task 5: Teach the shipped instructions

**Files:**
- Modify: `skills/kando/SKILL.md`, `skills/kando-refine/SKILL.md:49-59`, `skills/kando-autonomous-loop/SKILL.md:90`, `README.md:53`
- Mirror: the identical copies under `.claude/skills/**`

**Interfaces:**
- Consumes: the tool surface from Tasks 2–4 — `blockedBy` on `update_ticket` / `create_story` / `create_subtask`, `blockedBy` + `blocked` on `get_ticket`, and `next_task`'s new skip.
- Produces: nothing importable.

- [ ] **Step 1: Add the Dependencies section to the kando skill**

In `skills/kando/SKILL.md`, insert a new section immediately after the `## The ticket model` list (before `## Finding work`):

```markdown
## Dependencies (blocked by)

A ticket can be **blocked by** other tickets **on the same board** — the work that must
land first. `get_ticket` reports them:

- `blockedBy: ["KDO-7","KDO-9"]` — what this ticket waits on. It stays listed after the
  blocker is finished; the association is part of the record.
- `blocked: true` — at least one of them is **not resolved yet**.

A blocker counts as **resolved** once it is **Done** (the last column) or **off the
board** (archived or deleted). A container blocker is Done only when every one of its
subtasks is.

**Set them by `KEY-N`:** `update_ticket KDO-12 blockedBy:["KDO-7"]`, or pass `blockedBy`
straight to `create_story` / `create_subtask`. Pass `[]` to clear every dependency
(unlike the scalar fields, which clear with `""`). A ticket on another board is refused
— dependencies are same-board only.

**Use one when order is a constraint, not a preference.** Ranking a ticket higher says
"do this sooner"; `blockedBy` says "this cannot be done yet", and `next_task` enforces
it — a blocked ticket is never served, and neither are the subtasks of a blocked
container story.
```

- [ ] **Step 2: Teach `/kando-refine` to wire a sequence**

In `skills/kando-refine/SKILL.md`, extend step 4 of the decomposition section. After the `ensure_tag` bullet and before the closing "Create them in discussion order…" line, add:

```markdown
   - **If a step genuinely cannot start until an earlier one lands, say so with a dependency:** pass `blockedBy: ["<the earlier subtask's KEY-N>"]` to `create_subtask` (you have its `KEY-N` — you just created it). Rank is a preference; `blockedBy` is a constraint `/kando-loop` actually enforces. Use it only for a real prerequisite, not to re-state the order you already created them in.
```

- [ ] **Step 3: Teach the loop what a blocked ticket means**

In `skills/kando-autonomous-loop/SKILL.md`, step 1 of the loop currently reads
"If it returns `{ "none": true }` → this target is **exhausted**". Append a note
directly beneath that step:

```markdown
   `next_task` also skips a ticket whose `blockedBy` dependency is not resolved yet, and
   the subtasks of a blocked container story with it. That is normal, not a fault: the
   blocker is often a ticket **this loop is about to finish**, and the ticket becomes
   workable the moment its blocker reaches the last column. Never clear someone's
   `blockedBy` to unstick a target — work the blocker, or move on to the next target.
```

- [ ] **Step 4: Mention the surface in the README**

No new tool, so the `## Tools` list is unchanged. Add one paragraph to the end of the
`### Response shape` section, directly after the paragraph beginning "Boards are
addressed by **key**":

```markdown
A ticket can be **blocked by** other tickets on the same board. `get_ticket` reports
`blockedBy` (their `KEY-N`s) and `blocked: true` while any of them is unresolved; a
blocker resolves once it is Done or off the board. `next_task` never returns a blocked
ticket, nor the subtasks of a blocked container story. Set one with `blockedBy` on
`update_ticket` / `create_story` / `create_subtask`; `[]` clears.
```

- [ ] **Step 5: Sync the `.claude` mirrors**

```bash
cp skills/kando/SKILL.md .claude/skills/kando/SKILL.md
cp skills/kando-refine/SKILL.md .claude/skills/kando-refine/SKILL.md
cp skills/kando-autonomous-loop/SKILL.md .claude/skills/kando-autonomous-loop/SKILL.md
```

- [ ] **Step 6: Verify the mirrors are byte-identical**

```bash
for f in kando kando-refine kando-autonomous-loop; do
  cmp -s skills/$f/SKILL.md .claude/skills/$f/SKILL.md && echo "$f identical" || echo "$f DIFFERS"
done
```
Expected: three `identical` lines.

- [ ] **Step 7: Full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add skills .claude/skills README.md
git commit -m "docs(skills): teach the suite about blockedBy dependencies"
```

---

## Finishing

- [ ] `npm test && npm run typecheck` green on the branch.
- [ ] `git merge --no-ff blocked-by-dependencies` onto `main`, then delete the branch (local and remote if pushed) — per `CLAUDE.md`.
- [ ] **Release.** This change touches `dist` (via `src`) and `skills`, both in `package.json`'s `files`, so it ships. It is a **minor** — the server gains tool surface (`blockedBy` inputs) and the shipped skills gain a capability. Confirm the version with the human, then `npm version minor -m "chore: release v%s"`, push `main` **and** the tag, and watch `gh run list --workflow publish.yml --limit 1` go green. **Do not push the tag without the human's go-ahead.**
