# Thin `next_task` + server-resolved blocking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete this repo's copies of Kando's task-selection and blocking rules, and read the server's answers (`nextTask`, `activeBlockedBy`) instead.

**Architecture:** `next_task` becomes a ~20-line wrapper around one `nextTask` query, keeping its response contract byte-identical so the loop skill is untouched. `src/blocking.ts` is deleted; `get_ticket` and `search_tickets` read `activeBlockedBy` off the wire.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Zod input schemas, vitest, GraphQL operation strings hand-written in `src/operations.ts`.

**Spec:** `docs/superpowers/specs/2026-08-03-thin-next-task-design.md`

## Global Constraints

- **The backend query is `nextTask(target: String, excludeTags: [String!]): [NextTask!]!`** (KDO-99, live in Dev and Prod as of 2026-08-03). `NextTask` = `boardId boardKey ticket kind id storyId columnId title`; `kind` is `STORY|SUBTASK`; `storyId` is set only for a subtask.
- **`target` stays required on the tool** and is passed through verbatim — the server accepts a board key or a `KEY-N`. The cross-board fan-out (omitted target) is deliberately not exposed.
- **`excludeTags` is always `["human-needed", "pending-ship"]`** — this suite's conventions, resolved per board by the server, hard-coded nowhere else.
- **`next_task`'s response contract does not change:** `{ticket, kind, id, storyId?, columnId, title}` with **lowercase** `kind`, or `{none:true}`. The autonomous loop skill keys on `{none:true}`.
- **`activeBlockedBy`** is `[ID!]!` on `Story`/`Subtask` (ids, via `getBoard`) and `[String!]!` on `TicketSummary` (already `KEY-N`, via `getTickets`).
- **Imports are ESM with a `.js` suffix** even for `.ts` files.
- **`skills/` files have byte-identical tracked mirrors under `.claude/`.** Copy with `command cp` — plain `cp` is aliased to `cp -i` here and refuses silently.
- **Verification for every task:** `npm test` and `npm run typecheck` green before the commit.

---

## File Structure

**Deleted:** `src/blocking.ts`, `src/blocking.test.ts`.

**Modified:**
- `src/operations.ts` — `activeBlockedBy` in `storyFields`/`subtaskFields`; `blockedBy activeBlockedBy` in `GET_TICKETS`; new `NEXT_TASK`.
- `src/tools/loop.ts` — `next_task` rewritten; `selectNextTask`/`unitsFor`/`WorkScope`/`WorkItem` deleted; `botEmail` parameter dropped.
- `src/tools/loop.test.ts` — selection tests deleted, wrapper tests added.
- `src/server.ts` — the `registerLoopTools` call.
- `src/tools/read.ts` — `blockersFor` reads the server's fields.
- `src/tools/read.test.ts` — the blocked case now proves the derivation moved.
- `src/ticketSearch.ts` / `src/ticketSearch.test.ts` — `blocked` / `blockedBy` on a lean row.
- `src/live.e2e.test.ts` — a live `next_task`.
- `skills/kando/SKILL.md` (+ `.claude/` mirror), `README.md`.

---

### Task 1: Blocking moves to the server

**Files:**
- Delete: `src/blocking.ts`, `src/blocking.test.ts`
- Modify: `src/operations.ts` (`storyFields`, `subtaskFields`, `GET_TICKETS`), `src/tools/read.ts` (imports + `blockersFor` inside `get_ticket`), `src/ticketSearch.ts` (`leanSummary`)
- Test: `src/tools/read.test.ts`, `src/ticketSearch.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `LeanRow` gains `blockedBy?: string[]` and `blocked?: true`. `DetailOpts.blockers` is unchanged (`{list: string[]; blocked: boolean}`), so `shape.ts` is not touched.

- [ ] **Step 1: Write the failing tests**

In `src/tools/read.test.ts`, replace the two tests inside `describe('get_ticket dependencies', …)` so they assert against `activeBlockedBy` rather than a column comparison. Replace the whole `boardWithBlockers` fixture and both tests with:

```ts
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
        {
          id: 's1', num: 1, title: 'Blocked one', body: 'B', columnId: 'c1', tags: [],
          blockedBy: ['s2', 's3'], activeBlockedBy: ['s2'], subtasks: [],
        },
        { id: 's2', num: 2, title: 'Open blocker', columnId: 'c1', tags: [], blockedBy: [], activeBlockedBy: [], subtasks: [] },
        { id: 's3', num: 3, title: 'Done blocker', columnId: 'c2', tags: [], blockedBy: [], activeBlockedBy: [], subtasks: [] },
      ],
    },
  };

  const stubFor = (bc: any) =>
    vi.fn(async (query: string) => {
      if (query.includes('resolveTicket')) {
        return { resolveTicket: { boardId: 'b1', storyId: 's1', subtaskId: null, archived: false } };
      }
      if (query.includes('comments')) return { comments: [] };
      return bc;
    });

  it('lists the stored relation and flags blocked from activeBlockedBy', async () => {
    const { host, tools } = captureHost();
    registerReadTools(host, stubFor(boardWithBlockers) as never);
    const out = JSON.parse((await tools.get_ticket({ ticket: 'KDO-1' })).content[0].text);
    expect(out.blockedBy).toEqual(['KDO-2', 'KDO-3']);
    expect(out.blocked).toBe(true);
  });

  it('trusts an EMPTY activeBlockedBy even while a blocker sits in a live column', async () => {
    // The proof the derivation moved: s2 is still in `c1`, which the old
    // client-side rule would have called blocking. The server says otherwise,
    // and the server is the one decision point now (KDO-97/98).
    const server = structuredClone(boardWithBlockers);
    server.getBoard.stories[0].activeBlockedBy = [];
    const { host, tools } = captureHost();
    registerReadTools(host, stubFor(server) as never);
    const out = JSON.parse((await tools.get_ticket({ ticket: 'KDO-1' })).content[0].text);
    expect(out.blockedBy).toEqual(['KDO-2', 'KDO-3']);
    expect(out).not.toHaveProperty('blocked');
  });
```

And append to `describe('leanSummary', …)` in `src/ticketSearch.test.ts`:

```ts
  it('names the stored blockers and flags blocked from activeBlockedBy', () => {
    const r = leanSummary({ ...row, blockedBy: ['KDO-7', 'KDO-9'], activeBlockedBy: ['KDO-7'] });
    expect(r.blockedBy).toEqual(['KDO-7', 'KDO-9']);
    expect(r.blocked).toBe(true);
  });

  it('keeps a fully-resolved dependency listed without flagging it', () => {
    const r = leanSummary({ ...row, blockedBy: ['KDO-7'], activeBlockedBy: [] });
    expect(r.blockedBy).toEqual(['KDO-7']);
    expect(r).not.toHaveProperty('blocked');
  });

  it('emits neither field when there are no dependencies', () => {
    expect(leanSummary(row)).not.toHaveProperty('blockedBy');
    expect(leanSummary(row)).not.toHaveProperty('blocked');
  });
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run src/tools/read.test.ts src/ticketSearch.test.ts`
Expected: FAIL — `read.test.ts`'s second case still reports `blocked: true` (the client-side rule); `leanSummary` has no `blockedBy`/`blocked`.

- [ ] **Step 3: Select the server's field**

In `src/operations.ts`, add `activeBlockedBy` beside `blockedBy` in both field lists:

```ts
const subtaskFields = `
  id num boardId storyId title body tags columnId rank
  releaseId estimateHours excludedFromRelease visibleAt assignee creator archivedAt blockedBy activeBlockedBy`;

const storyFields = `
  id num boardId title body tags columnId rank
  releaseId estimateHours visibleAt assignee creator archivedAt blockedBy activeBlockedBy
  subtasks { ${subtaskFields} }`;
```

and in `GET_TICKETS`, extend the item selection:

```graphql
      items {
        ticket parent title columnLabel subtaskCount
        tags releaseName assignee assigneeEmail visibleAt archivedAt
        blockedBy activeBlockedBy
      }
```

- [ ] **Step 4: Read it in `get_ticket`**

In `src/tools/read.ts`, drop the blocking import:

```ts
// delete: import { buildBlockerIndex, unresolvedBlockers, blockerTickets } from '../blocking.js';
```

and replace the index + helper inside `get_ticket` with:

```ts
      // KDO-97/98: "is this actually blocking?" is resolved in the backend —
      // `activeBlockedBy` is the subset still genuinely outstanding, shared by
      // getBoard/getTickets/nextTask. We report it, never re-derive it.
      // `blockedBy` stays the raw stored relation: the record of what was linked.
      // An id ctx cannot name is an archived blocker (getBoard returns no
      // archived rows) — dropped rather than rendered as a broken reference.
      const blockersFor = (raw: any) => ({
        list: (raw.blockedBy ?? [])
          .map((id: string) => ctx.ticketOf.get(id))
          .filter((t: string | undefined): t is string => t != null),
        blocked: (raw.activeBlockedBy ?? []).length > 0,
      });
```

Then `blockers: blockersFor(sub)` in the subtask branch and `blockers: blockersFor(story)` in the story branch — the parent argument is gone, since the server already folds a container's blockers into its subtask's `activeBlockedBy`.

- [ ] **Step 5: Read it in `leanSummary`**

In `src/ticketSearch.ts`, add to `LeanRow`:

```ts
  blockedBy?: string[];
  blocked?: boolean;
```

and to `leanSummary`, after the `archivedAt` line:

```ts
  // KDO-96: both already KEY-N from the server. `blockedBy` is the stored
  // relation; `blocked` is the server's verdict on whether any of it still
  // stands (KDO-98's activeBlockedBy) — never recomputed here.
  if (s.blockedBy?.length) out.blockedBy = s.blockedBy;
  if (s.activeBlockedBy?.length) out.blocked = true;
```

- [ ] **Step 6: Delete the module**

```bash
git rm src/blocking.ts src/blocking.test.ts
```

- [ ] **Step 7: Run the tests — they must pass**

Run: `npx vitest run src/tools/read.test.ts src/ticketSearch.test.ts`
Expected: PASS.

- [ ] **Step 8: Full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: all green. `src/tools/loop.ts` still imports `../blocking.js` at this point and will fail to typecheck — if it does, do **not** patch it here; that import disappears with `selectNextTask` in Task 2. Instead, make Task 2's edit now and commit the two together.

- [ ] **Step 9: Commit**

```bash
git add -A src/operations.ts src/tools/read.ts src/tools/read.test.ts src/ticketSearch.ts src/ticketSearch.test.ts src/blocking.ts src/blocking.test.ts
git commit -m "feat(blocking): read the server's activeBlockedBy instead of deriving it"
```

---

### Task 2: `next_task` becomes a wrapper

**Files:**
- Modify: `src/operations.ts` (append `NEXT_TASK`), `src/tools/loop.ts` (delete `unitsFor`/`selectNextTask`/`WorkScope`/`WorkItem`, rewrite `next_task`, drop `botEmail`), `src/server.ts:23`
- Test: `src/tools/loop.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  ```ts
  // src/operations.ts
  export const NEXT_TASK: string;
  // src/tools/loop.ts
  export function registerLoopTools(server: ToolHost, gql: Gql): void;   // botEmail parameter GONE
  ```
  `next_task({target})` still returns `{ticket, kind, id, storyId?, columnId, title}` or `{none:true}`.

- [ ] **Step 1: Write the failing tests**

In `src/tools/loop.test.ts`: delete the entire `describe('selectNextTask', …)` block and the `const board = {…}` fixture it uses, and remove `selectNextTask` from the import on line 2. Update the two `ensure_tag` tests to call `registerLoopTools(host, gql as never)` — no third argument. Then append:

```ts
describe('next_task', () => {
  const entry = {
    ticket: 'TSK-6',
    kind: 'SUBTASK',
    id: 'sub1',
    storyId: 's5',
    columnId: 'c1',
    title: 'E-1',
  };

  const stub = (data: any) => {
    const calls: Array<{ query: string; variables: any }> = [];
    const gql = vi.fn(async (query: string, variables: any) => {
      calls.push({ query, variables });
      return data;
    });
    return { calls, gql };
  };

  it('asks the server, passing the target and the loop\'s own exclude tags', async () => {
    const { calls, gql } = stub({ nextTask: [entry] });
    const { host, tools } = capture();
    registerLoopTools(host, gql as never);

    await tools.next_task({ target: 'TSK' });

    expect(calls).toHaveLength(1);
    expect(calls[0].query).toContain('nextTask');
    expect(calls[0].variables).toEqual({
      target: 'TSK',
      excludeTags: ['human-needed', 'pending-ship'],
    });
  });

  it('returns the first entry with kind lowercased — the contract the loop reads', async () => {
    const { gql } = stub({ nextTask: [entry] });
    const { host, tools } = capture();
    registerLoopTools(host, gql as never);

    const out = JSON.parse((await tools.next_task({ target: 'TSK-5' })).content[0].text);
    expect(out).toEqual({
      ticket: 'TSK-6',
      kind: 'subtask',
      id: 'sub1',
      storyId: 's5',
      columnId: 'c1',
      title: 'E-1',
    });
  });

  it('omits storyId for a standalone story', async () => {
    const { gql } = stub({
      nextTask: [{ ticket: 'TSK-1', kind: 'STORY', id: 's1', storyId: null, columnId: 'c1', title: 'A' }],
    });
    const { host, tools } = capture();
    registerLoopTools(host, gql as never);

    const out = JSON.parse((await tools.next_task({ target: 'TSK' })).content[0].text);
    expect(out.kind).toBe('story');
    expect(out).not.toHaveProperty('storyId');
  });

  it('an empty list is {none:true} — nothing workable in that target', async () => {
    const { gql } = stub({ nextTask: [] });
    const { host, tools } = capture();
    registerLoopTools(host, gql as never);

    const out = JSON.parse((await tools.next_task({ target: 'TSK' })).content[0].text);
    expect(out).toEqual({ none: true });
  });

  it('re-raises BAD_INPUT with a read-shaped message naming both causes', async () => {
    const gql = vi.fn(async () => {
      throw new KandoError('That didn\'t save — a value isn\'t valid.', 'BAD_INPUT');
    });
    const { host, tools } = capture();
    registerLoopTools(host, gql as never);

    // The server cannot say WHICH, so the message names both — still far more
    // useful than the write-shaped generic ("the change was not saved").
    await expect(tools.next_task({ target: 'TSK-9' })).rejects.toThrow(/archived|board key/i);
    await expect(tools.next_task({ target: 'TSK-9' })).rejects.not.toThrow(/didn't save/i);
  });

  it('lets any other error through untouched', async () => {
    const gql = vi.fn(async () => {
      throw new KandoError('The bot lacks permission on this board.', 'UNAUTHORIZED');
    });
    const { host, tools } = capture();
    registerLoopTools(host, gql as never);
    await expect(tools.next_task({ target: 'TSK' })).rejects.toThrow(/permission/i);
  });
});
```

Add `KandoError` to the imports at the top of `src/tools/loop.test.ts`:

```ts
import { KandoError } from '../graphql.js';
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run src/tools/loop.test.ts`
Expected: FAIL — the tool still calls `getBoard`/`resolveTicket`, and `registerLoopTools` takes three arguments.

- [ ] **Step 3: Add the query**

Append to `src/operations.ts`:

```ts
// KDO-99: the loop's task-selection rule, server-side. `excludeTags` are NAMES,
// resolved per board — the loop's `human-needed`/`pending-ship` conventions stay
// the caller's, not Kando's. Always a list: 0 or 1 entry for a target, so the
// tool takes the first. No `boardId`/`boardKey` in the selection — `KEY-N`
// already names the board.
export const NEXT_TASK = `
  query NextTask($target: String, $excludeTags: [String!]) {
    nextTask(target: $target, excludeTags: $excludeTags) {
      ticket kind id storyId columnId title
    }
  }`;
```

- [ ] **Step 4: Rewrite `next_task`**

In `src/tools/loop.ts`:

1. Replace the imports at the top with:
   ```ts
   import { z } from 'zod';
   import { KandoError } from '../graphql.js';
   import { type Gql, type ToolHost, toolText, resolveBoardId } from './read.js';
   import { GET_BOARD, CREATE_TAG, NEXT_TASK } from '../operations.js';
   ```
   (`resolveBoardId`, `GET_BOARD` and `CREATE_TAG` are still needed — by `ensure_tag`.)
2. Delete `WorkScope`, `WorkItem`, `Unit`, `unitsFor` and `selectNextTask` entirely, with their doc comments. The tier reasoning now lives in Kando's `infra/lambda/api/nextTask.ts`, which is where the rule is.
3. Add, above `registerLoopTools`:
   ```ts
   /**
    * The tags this suite treats as "not workable by the loop": a ticket a human
    * has claimed, and one the loop has finished and parked on its branch awaiting
    * a batched deploy. The server resolves these NAMES per board and hard-codes
    * neither — they are this suite's conventions, not Kando's.
    */
   const EXCLUDE_TAGS = ['human-needed', 'pending-ship'];
   ```
4. Change the signature: `export function registerLoopTools(server: ToolHost, gql: Gql) {` — the bot's identity is the caller's identity server-side, so no member lookup and no `botEmail`.
5. Replace the whole `next_task` registration with:
   ```ts
   server.registerTool(
     'next_task',
     {
       description:
         'Return the next workable ticket in a target (board key, or a KEY-N story/subtask), or {none:true}. ' +
         'Selection happens in Kando (KDO-99), so every consumer gets the same answer: subtasks of a STARTED ' +
         'container story first — one with a subtask past the first column, incl. Done — then standalone ' +
         'stories, then subtasks of untouched containers. Skips Done, snoozed, blocked (an unresolved ' +
         'blockedBy dependency, including one inherited from the container story), tickets assigned to ' +
         'someone else, and the human-needed / pending-ship tags. pending-ship marks a ticket the autonomous ' +
         'loop has finished and parked on its branch awaiting a batched deploy; the loop clears it once the ' +
         'batch ships. Work units are standalone stories and subtasks, never a container story.',
       inputSchema: { target: z.string().describe('board key/id, or a ticket KEY-N') },
     },
     async ({ target }) => {
       let list: any[];
       try {
         list = (await gql(NEXT_TASK, { target, excludeTags: EXCLUDE_TAGS })).nextTask ?? [];
       } catch (e) {
         // BAD_INPUT's table message is write-shaped ("that didn't save"), which
         // is wrong on a read. The server does not say which of the two causes
         // it was, so name both.
         if (e instanceof KandoError && e.token === 'BAD_INPUT') {
           throw new KandoError(
             `next_task could not use the target "${target}": it is either archived (restore it with ` +
               'unarchive_ticket) or not a board key / KEY-N ticket id.',
             'BAD_INPUT',
           );
         }
         throw e;
       }
       const top = list[0];
       if (!top) return toolText({ none: true });
       return toolText({
         ticket: top.ticket ?? null,
         // The wire says STORY/SUBTASK; this tool has always said story/subtask.
         kind: String(top.kind).toLowerCase(),
         id: top.id,
         ...(top.storyId ? { storyId: top.storyId } : {}),
         columnId: top.columnId,
         title: top.title,
       });
     },
   );
   ```

- [ ] **Step 5: Update the caller**

In `src/server.ts`, line 23: `registerLoopTools(host, gql);` — drop `opts.email ?? ''`. Leave the other registrars' use of `opts.email` alone.

- [ ] **Step 6: Run the tests — they must pass**

Run: `npx vitest run src/tools/loop.test.ts`
Expected: PASS.

- [ ] **Step 7: Full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: all green, and no file imports `../blocking.js` any more.

- [ ] **Step 8: Commit**

```bash
git add src/operations.ts src/tools/loop.ts src/tools/loop.test.ts src/server.ts
git commit -m "feat(next_task): wrap the server's nextTask instead of re-implementing it"
```

---

### Task 3: Prove it live, and teach the suite

**Files:**
- Modify: `src/live.e2e.test.ts`, `skills/kando/SKILL.md`, `README.md`
- Mirror: `.claude/skills/kando/SKILL.md`

**Interfaces:**
- Consumes: `next_task` and the blocking fields from Tasks 1–2.
- Produces: nothing importable.

- [ ] **Step 1: Add the live check**

`src/live.e2e.test.ts` registers the read + ticket tools already. Add `registerLoopTools(host, gql)` beside them (import it from `./tools/loop.js`), then add this test inside the existing `describe`, after the create/move/archive one:

```ts
  /**
   * KDO-99 moved task selection into the backend; this is the only check that
   * the query, its arguments and its enum values are real. The board has one
   * live standalone story at this point, so it must come back workable.
   */
  it('next_task asks the deployed backend and gets the workable ticket', async () => {
    const created = JSON.parse(
      (await tools.create_story({ board: boardKey, title: 'e2e next_task' })).content[0].text,
    );
    const out = JSON.parse((await tools.next_task({ target: boardKey })).content[0].text);
    expect(out.ticket).toBe(created.ticket);
    expect(out.kind).toBe('story');
    expect(out).not.toHaveProperty('none');
  }, 30_000);
```

- [ ] **Step 2: Run it against Dev**

Run: `KANDO_LIVE=1 npx vitest run src/live.e2e.test.ts`
Expected: PASS. A failure here means the query text or an argument name is wrong — a stub cannot catch that.

- [ ] **Step 3: Simplify the skill's Dependencies section**

In `skills/kando/SKILL.md`, replace the paragraph beginning "A blocker counts as **resolved**" (and its container sentence) with:

```markdown
**Kando decides what still blocks, not you.** A blocker stops counting once it is Done,
archived or deleted — resolved in one place in the backend, so `get_ticket`,
`search_tickets` and `next_task` can never disagree. Read `blocked`; never work it out
from a blocker's column yourself.
```

and add to the end of that section:

```markdown
`search_tickets` reports `blocked` too, so a list tells you which rows are unworkable
without a `get_ticket` per row.
```

- [ ] **Step 4: Note it in the README**

In `README.md`, in the dependencies paragraph of `### Response shape`, replace the sentence "a blocker resolves once it is Done or off the board" with:

```markdown
whether a blocker still counts is resolved by Kando itself (Done, archived or deleted
stops blocking), so every tool agrees;
```

- [ ] **Step 5: Sync the mirror and verify**

```bash
command cp skills/kando/SKILL.md .claude/skills/kando/SKILL.md
cmp -s skills/kando/SKILL.md .claude/skills/kando/SKILL.md && echo identical || echo DIFFERS
```
Expected: `identical`.

- [ ] **Step 6: Full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/live.e2e.test.ts skills .claude/skills README.md
git commit -m "docs(skills): Kando resolves blocking state, not this server"
```

---

## Finishing

- [ ] `npm test && npm run typecheck` green, and the live e2e green against Dev.
- [ ] `git merge --no-ff thin-next-task` onto `main`, then delete the branch — per `CLAUDE.md`.
- [ ] **Release.** `dist` and `skills` both change, so it ships. **minor** — `search_tickets` rows gain `blocked`/`blockedBy`, and the server now requires a backend with `nextTask` (v0.9.0 stays working for anyone who does not upgrade). Confirm the number with the human, then `npm version minor -m "chore: release v%s"`, push `main` **and** the tag, and watch `gh run list --workflow publish.yml --limit 1`. **Do not push the tag without the human's go-ahead.**
