import { z } from 'zod';
import { type Gql, type ToolHost, toolText, resolveBoardId } from './read.js';
import { resolveTicketRef, requireLive } from '../tickets.js';
import { buildBlockerIndex, unresolvedBlockers } from '../blocking.js';
import { GET_BOARD, CREATE_TAG } from '../operations.js';

const KNOWN_TAG_COLORS: Record<string, { colorBg: string; colorText: string }> = {
  claude: { colorBg: '#FFF1E0', colorText: '#B76E00' }, // orange
  'human-needed': { colorBg: '#FCE7F3', colorText: '#BE185D' }, // pink
  refined: { colorBg: '#E3F6EA', colorText: '#1F845A' }, // green
};

export function pickTagColors(name: string): { colorBg: string; colorText: string } {
  return KNOWN_TAG_COLORS[name.toLowerCase()] ?? { colorBg: '#EEF0F2', colorText: '#5C6B7A' };
}

export type WorkScope =
  | { kind: 'board' }
  | { kind: 'story'; storyId: string }
  | { kind: 'subtask'; storyId: string; subtaskId: string };

export type WorkItem = {
  ticket: string | null;
  kind: 'story' | 'subtask';
  id: string;
  storyId?: string;
  columnId: string;
  title: string;
};

type Unit = { kind: 'story' | 'subtask'; story: any; item: any };

/**
 * Emit work units for a board in **three tiers**:
 *
 *   1. subtasks of **started** containers — a container with ≥1 subtask that is
 *      no longer in the FIRST column,
 *   2. **standalone stories**,
 *   3. subtasks of **untouched** containers (every subtask still in the first column).
 *
 * Tier 2 before tier 3 is the long-standing rule: the loop drains self-contained
 * standalone stories before it opens any container, so a board's simple tickets
 * ship first (deliberately departing from the UI's top-to-bottom layout, which
 * shows swimlanes above the standalone lane). Tier 1 is what makes the loop
 * **finish what it started**: `next_task` re-scans the board from scratch on every
 * call, so without it a standalone created midway through a container's subtasks
 * would jump the queue and strand the half-finished container. Tier 1 is empty on
 * a board where no container has been touched, so the general rule is unchanged
 * there — the tier only bites once work is in flight.
 *
 * "Started" counts **Done** subtasks, and that is load-bearing: the loop's last
 * act on a ticket is moving it to the last column, so a container it just worked
 * has no subtask sitting in an in-progress column. Done is the evidence that work
 * happened. It also covers a container a **human** started, which is right.
 *
 * Within each tier `bc.stories` already arrives sorted by `rank` from the backend,
 * so filtering preserves lane order. Work units are standalone stories and
 * subtasks — never a container story itself. (A container whose subtasks are all
 * Done is "started" but contributes only Done subtasks, which the eligibility
 * filter drops, so it cannot block a standalone.)
 *
 * **`pending-ship` is a loop-internal hold, not a user-facing tag.** Under batched
 * deploys a ticket the loop has implemented, reviewed and parked on its
 * `kando-loop/*` branch is *not* Done — it has not shipped — so it stays in an
 * in-progress column, still assigned to the bot. That makes it indistinguishable
 * from workable, and `next_task` would serve it again forever. The coordinator
 * tags it `pending-ship` on review pass and clears the tag when the batch merges
 * to `main` and its verification goes green. Excluding it here is what lets the
 * loop advance past its own finished work.
 */
// `firstCol` is the board's FIRST column id (lowest `order`, not array position) —
// only the board scope reads it; selectNextTask has already sorted the columns and
// bailed on a column-less board, so it is always a real id.
function unitsFor(bc: any, scope: WorkScope, firstCol: string): Unit[] {
  const stories = bc.stories ?? [];
  const out: Unit[] = [];
  const isContainer = (s: any) => (s.subtasks?.length ?? 0) > 0;
  if (scope.kind === 'board') {
    const isStarted = (s: any) => (s.subtasks ?? []).some((sub: any) => sub.columnId !== firstCol);
    // ONE pass over the (already rank-sorted) stories, partitioned into the three
    // tiers; each tier therefore keeps lane order.
    const started: any[] = [];
    const standalone: any[] = [];
    const untouched: any[] = [];
    for (const s of stories) {
      if (!isContainer(s)) standalone.push(s);
      else if (isStarted(s)) started.push(s);
      else untouched.push(s);
    }
    for (const s of started) for (const sub of s.subtasks) out.push({ kind: 'subtask', story: s, item: sub });
    for (const s of standalone) out.push({ kind: 'story', story: s, item: s });
    for (const s of untouched) for (const sub of s.subtasks) out.push({ kind: 'subtask', story: s, item: sub });
  } else if (scope.kind === 'story') {
    const s = stories.find((x: any) => x.id === scope.storyId);
    if (s && isContainer(s)) for (const sub of s.subtasks) out.push({ kind: 'subtask', story: s, item: sub });
    else if (s) out.push({ kind: 'story', story: s, item: s });
  } else {
    const s = stories.find((x: any) => x.id === scope.storyId);
    const sub = s?.subtasks?.find((x: any) => x.id === scope.subtaskId);
    if (s && sub) out.push({ kind: 'subtask', story: s, item: sub });
  }
  return out;
}

export function selectNextTask(bc: any, scope: WorkScope, botSub: string | null): WorkItem | null {
  const cols = [...(bc.board?.columns ?? [])].sort((a: any, b: any) => a.order - b.order);
  if (!cols.length) return null;
  const lastCol = cols[cols.length - 1].id;
  const hnId = (bc.tags ?? []).find((t: any) => (t.name ?? '').toLowerCase() === 'human-needed')?.id;
  const psId = (bc.tags ?? []).find((t: any) => (t.name ?? '').toLowerCase() === 'pending-ship')?.id;
  const now = Date.now();

  // Order = subtasks of STARTED containers, then standalone stories, then subtasks of
  // untouched containers (see unitsFor), each tier in the rank order getBoard returns.
  // We pick the FIRST eligible unit in it.
  // We do NOT re-sort WITHIN a tier: there, column stage is not a priority (only the
  // last column = Done is excluded below), and rank is a per-lane fractional index that
  // is meaningless to compare across different stories. Column stage matters only at the
  // CONTAINER level, where it decides the tier (started vs untouched) — never between two
  // units of the same tier.
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
  if (!top) return null;
  const key = bc.board?.key ?? null;
  const num = top.item.num;
  return {
    ticket: key && typeof num === 'number' ? `${key}-${num}` : null,
    kind: top.kind,
    id: top.item.id,
    storyId: top.kind === 'subtask' ? top.story.id : undefined,
    columnId: top.item.columnId,
    title: top.item.title,
  };
}

export function registerLoopTools(server: ToolHost, gql: Gql, botEmail: string) {
  server.registerTool(
    'ensure_tag',
    {
      description:
        "Ensure a board tag exists by name, creating it (fixed colors) if it doesn't exist yet. " +
        'Apply tags to tickets by NAME with update_ticket.',
      inputSchema: { board: z.string(), name: z.string() },
    },
    async ({ board, name }) => {
      const boardId = await resolveBoardId(gql, board);
      const data = await gql(GET_BOARD, { boardId });
      const existing = (data.getBoard.tags ?? []).find(
        (t: any) => (t.name ?? '').toLowerCase() === name.toLowerCase(),
      );
      if (existing) return toolText({ tag: existing.name, created: false });
      const { colorBg, colorText } = pickTagColors(name);
      const d = await gql(CREATE_TAG, { boardId, name, colorBg, colorText });
      return toolText({ tag: d.createTag.tag.name, created: true });
    },
  );

  server.registerTool(
    'next_task',
    {
      description:
        'Return the next workable ticket in a target (board key, or a KEY-N story/subtask), or {none:true}. ' +
        'For a board it picks in three tiers: (1) subtasks of a STARTED container story (one with a subtask past the first column, incl. Done) — ' +
        'so a container already in flight is finished before anything new is opened; (2) standalone stories; (3) subtasks of untouched containers. ' +
        'On a board where no container has been started, that is simply standalone stories before container swimlanes, as before. ' +
        'Skips Done, snoozed, human-needed, pending-ship, blocked, and tickets assigned to a human. ' +
        'BLOCKED means an unresolved blockedBy dependency — a blocker counts as resolved once it is Done or off the board ' +
        '(archived/deleted); a subtask is also blocked while its container story is. ' +
        'pending-ship marks a ticket the autonomous loop has finished and parked on its branch awaiting a batched deploy — ' +
        'it is not workable, and the loop clears the tag once the batch ships. Work units are standalone stories and subtasks.',
      inputSchema: { target: z.string().describe('board key/id, or a ticket KEY-N') },
    },
    async ({ target }) => {
      const isTicket = /^[A-Za-z]{1,10}-\d+$/.test(target.trim());
      let boardId: string;
      let scope: WorkScope;
      if (isTicket) {
        // An archived target has no work in it, and would otherwise read as an
        // empty board — which the loop reports as "nothing left to do".
        const ref = requireLive(await resolveTicketRef(gql, target), target);
        boardId = ref.boardId;
        scope = ref.subtaskId
          ? { kind: 'subtask', storyId: ref.storyId!, subtaskId: ref.subtaskId }
          : { kind: 'story', storyId: ref.storyId! };
      } else {
        boardId = await resolveBoardId(gql, target);
        scope = { kind: 'board' };
      }
      const data = await gql(GET_BOARD, { boardId });
      const bc = data.getBoard;
      const botMember = (bc.members ?? []).find(
        (m: any) => (m.email ?? '').toLowerCase() === botEmail.toLowerCase(),
      );
      const next = selectNextTask(bc, scope, botMember?.userSub ?? null);
      return toolText(next ?? { none: true });
    },
  );
}
