import { z } from 'zod';
import { KandoError, type GqlClient } from '../graphql.js';
import { MY_BOARDS, GET_BOARD, ARCHIVED_ITEMS, COMMENTS } from '../operations.js';
import { flattenBoard, filterItems, resolveTicketRef, type TicketRef } from '../tickets.js';
import { buildContext, leanItem, leanDetail, leanComments, COMMENT_CAP } from '../shape.js';
import { resolveTagIds, resolveReleaseId, resolveAssignee } from '../resolve.js';
import { buildBlockerIndex, unresolvedBlockers, blockerTickets } from '../blocking.js';

export type Gql = GqlClient;

export type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

/** The subset of McpServer the registrars use — lets tests pass a capturing stub. */
export interface ToolHost {
  registerTool(
    name: string,
    config: { description?: string; inputSchema?: Record<string, z.ZodTypeAny> },
    cb: (args: any) => Promise<ToolResult>,
  ): unknown;
}

/** Compact on purpose: the 2-space indent was ~26% of every response. */
export function toolText(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

/**
 * Read one archived ticket.
 *
 * `getBoard` drops archived rows wholesale, so the ticket itself has to come from
 * `archivedItems`; the board is still read alongside it, purely for the registries
 * that turn ids into names (tags, members, releases, column labels).
 *
 * Returning it marked `archived` is the point: before KDO-90 this path answered
 * "no longer exists" for a ticket sitting in the archive intact, which reads as
 * deleted and cost a caller the body they were trying to recover.
 */
async function archivedDetail(
  gql: Gql,
  ref: TicketRef,
  ticket: string,
  itemId?: string,
): Promise<ToolResult> {
  const [adata, bdata, cdata] = await Promise.all([
    gql(ARCHIVED_ITEMS, { boardId: ref.boardId }),
    gql(GET_BOARD, { boardId: ref.boardId }),
    gql(COMMENTS, { boardId: ref.boardId, itemId }),
  ]);
  const entries: any[] = adata.archivedItems ?? [];
  const mine = entries.find((a) =>
    ref.subtaskId ? a.subtask?.id === ref.subtaskId : a.story?.id === ref.storyId,
  );
  // Resolved as archived yet missing from the archive: the row really is gone.
  if (!mine) throw new KandoError('That no longer exists — it may have been deleted.', 'NOT_FOUND');

  const bc = bdata.getBoard;
  const ctx = buildContext(bc);
  const labelOf = new Map<string, string>(
    (bc.board?.columns ?? []).map((c: any) => [c.id, c.label]),
  );
  const key: string | null = bc.board?.key ?? null;
  const ticketOf = (num: unknown) =>
    key && typeof num === 'number' ? `${key}-${num}` : null;
  // ctx is built from the live board, so it cannot name anything in the archive.
  // Register the archived items themselves and KEY-N references resolve as usual
  // — notably a child naming the parent it was archived with.
  for (const a of entries) {
    const it = a.story ?? a.subtask;
    const t = ticketOf(it?.num);
    if (it && t) ctx.ticketOf.set(it.id, t);
  }
  const raw = mine.story ?? mine.subtask;
  const { comments, earlier } = leanComments(cdata.comments, ctx, COMMENT_CAP);

  // Archiving a story cascades to its subtasks (they are archived with it), so a
  // container's children are in this same payload — not on the board.
  const subs = mine.story
    ? entries
        .filter((a) => a.subtask?.storyId === raw.id)
        .map((a) => ({
          kind: 'subtask' as const,
          id: a.subtask.id,
          storyId: a.subtask.storyId,
          ticket: ticketOf(a.subtask.num),
          title: a.subtask.title,
          columnId: a.subtask.columnId,
          columnLabel: labelOf.get(a.subtask.columnId) ?? a.subtask.columnId,
          assignee: a.subtask.assignee ?? null,
          tags: a.subtask.tags ?? [],
          releaseId: a.subtask.releaseId ?? null,
          snoozed: false,
          body: null,
        }))
    : undefined;

  const out = leanDetail(raw, ctx, {
    kind: mine.story ? 'story' : 'subtask',
    // The archived ticket is absent from the board, so ctx cannot name it — but
    // the caller just asked for it by key, which is the same answer.
    ticket,
    columnLabel: labelOf.get(raw.columnId) ?? raw.columnId,
    parent: mine.subtask ? ctx.ticketOf.get(raw.storyId) : undefined,
    subtasks: subs?.length ? subs : undefined,
  });
  out.archived = true;
  out.archivedAt = mine.archivedAt;
  if (comments.length) out.comments = comments;
  if (earlier) out.earlierComments = earlier;
  return toolText(out);
}

const KEY_RE = /^[A-Z]{1,10}$/;

/** `board` is a board KEY (all-caps letters) to look up, or a raw id passed through. */
export async function resolveBoardId(gql: Gql, board: string): Promise<string> {
  if (!KEY_RE.test(board)) return board;
  const data = await gql(MY_BOARDS);
  const match = (data.myBoards ?? []).find((b: any) => b.key === board);
  if (!match) throw new KandoError(`No board with key "${board}" is visible to the bot.`, 'NOT_FOUND');
  return match.id;
}

export type BoardField = 'board' | 'items' | 'tags' | 'releases' | 'members';

/**
 * Narrow a get_board payload to the requested sections. An absent or empty list means
 * every section — callers that pass nothing must keep seeing the whole board, and an
 * empty array is far more likely to be a caller bug than a request for nothing.
 */
export function selectBoardFields<T extends Record<string, unknown>>(
  payload: T,
  fields?: BoardField[],
): Partial<T> {
  if (!fields || fields.length === 0) return payload;
  const out: Partial<T> = {};
  for (const f of fields) {
    if (f in payload) out[f as keyof T] = payload[f as keyof T];
  }
  return out;
}

export function registerReadTools(server: ToolHost, gql: Gql, botEmail: string | null = null) {
  server.registerTool(
    'list_boards',
    { description: 'List the Kando boards the bot can see (call this first).', inputSchema: {} },
    async () => {
      const data = await gql(MY_BOARDS);
      const boards = (data.myBoards ?? []).map((b: any) => ({
        id: b.id,
        key: b.key,
        name: b.name,
        role: b.role,
        columns: [...(b.columns ?? [])].sort((a: any, c: any) => a.order - c.order).map((c: any) => c.label),
      }));
      return toolText(boards);
    },
  );

  server.registerTool(
    'get_board',
    {
      description:
        'Get a board: columns, non-archived tickets, tags, releases and members. ' +
        'Tickets come back as identifiers only (KEY-N, title, column, tags, assignee) — ' +
        "NO bodies. Use get_ticket for a ticket's description or spec.",
      inputSchema: {
        board: z.string().describe('board key (e.g. TSK) or id'),
        fields: z
          .array(z.enum(['board', 'items', 'tags', 'releases', 'members']))
          .optional()
          .describe('sections to return; omit for all. Use ["board"] for just the column names.'),
      },
    },
    async ({ board, fields }) => {
      const boardId = await resolveBoardId(gql, board);
      const data = await gql(GET_BOARD, { boardId });
      const bc = data.getBoard;
      const ctx = buildContext(bc);
      return toolText(selectBoardFields({
        board: {
          key: bc.board.key,
          name: bc.board.name,
          role: bc.board.role,
          columns: [...(bc.board.columns ?? [])]
            .sort((a: any, c: any) => a.order - c.order)
            .map((c: any) => c.label),
        },
        items: flattenBoard(bc).map((i) => leanItem(i, ctx)),
        tags: (bc.tags ?? []).map((t: any) => t.name),
        releases: (bc.releases ?? []).map((r: any) => ({ name: r.name, targetDate: r.targetDate })),
        members: (bc.members ?? []).map((m: any) => {
          const o: Record<string, unknown> = { email: m.email };
          if (m.displayName) o.name = m.displayName;
          o.role = m.role;
          return o;
        }),
      }, fields));
    },
  );

  server.registerTool(
    'get_ticket',
    {
      description:
        'Get full detail for one ticket by KEY-N, INCLUDING its body — the only tool that ' +
        'returns one. A container story also lists its subtasks, without their bodies. ' +
        `Inlines the ${COMMENT_CAP} most recent comments (its own only, never a subtask's); ` +
        'use list_comments for the rest.',
      inputSchema: { ticket: z.string().describe('ticket id, e.g. TSK-42') },
    },
    async ({ ticket }) => {
      const ref = await resolveTicketRef(gql, ticket);
      const itemId = ref.subtaskId ?? ref.storyId;
      // An archived ticket is readable but absent from getBoard, which drops
      // archived rows wholesale — it has to come from the archive instead.
      if (ref.archived) return archivedDetail(gql, ref, ticket, itemId);
      // The ref already names the item, so the comments read does not have to
      // wait on the board read — only on the resolve that produced both ids.
      const [data, cdata] = await Promise.all([
        gql(GET_BOARD, { boardId: ref.boardId }),
        gql(COMMENTS, { boardId: ref.boardId, itemId }),
      ]);
      const bc = data.getBoard;
      const ctx = buildContext(bc);
      const labelOf = new Map<string, string>(
        (bc.board?.columns ?? []).map((c: any) => [c.id, c.label]),
      );
      // Only THIS ticket's comments. A container lists its subtasks, never their
      // discussion — one item id was asked about, one is answered.
      const { comments, earlier } = leanComments(cdata.comments, ctx, COMMENT_CAP);
      const withComments = (out: Record<string, unknown>) => {
        if (comments.length) out.comments = comments;
        if (earlier) out.earlierComments = earlier;
        return out;
      };
      const bIndex = buildBlockerIndex(bc);
      // A subtask inherits its container's blockers for the `blocked` verdict —
      // the same rule next_task applies — but `blockedBy` names only its own,
      // which is what somebody actually linked to this ticket.
      const blockersFor = (raw: any, parent: any | null) => ({
        list: blockerTickets(raw, bIndex),
        blocked: unresolvedBlockers(raw, parent, bIndex).length > 0,
      });
      const story = (bc.stories ?? []).find((s: any) => s.id === ref.storyId);
      if (!story) throw new KandoError('That story no longer exists.', 'NOT_FOUND');
      if (ref.subtaskId) {
        const sub = (story.subtasks ?? []).find((x: any) => x.id === ref.subtaskId);
        if (!sub) throw new KandoError('That subtask no longer exists.', 'NOT_FOUND');
        return toolText(withComments(leanDetail(sub, ctx, {
          kind: 'subtask',
          ticket: ctx.ticketOf.get(sub.id) ?? null,
          columnLabel: labelOf.get(sub.columnId) ?? sub.columnId,
          parent: ctx.ticketOf.get(story.id),
          blockers: blockersFor(sub, story),
        })));
      }
      // Reuse flattenBoard so the subtask list obeys the same archived rules as
      // every other list, then keep only this story's children.
      const subs = flattenBoard(bc).filter((i) => i.storyId === story.id);
      return toolText(withComments(leanDetail(story, ctx, {
        kind: 'story',
        ticket: ctx.ticketOf.get(story.id) ?? null,
        columnLabel: labelOf.get(story.columnId) ?? story.columnId,
        subtasks: subs.length ? subs : undefined,
        blockers: blockersFor(story, null),
      })));
    },
  );

  server.registerTool(
    'search_tickets',
    {
      description:
        "Search a board's non-archived tickets. Filters combine with AND. Returns " +
        'identifiers only — use get_ticket for a body (text still searches bodies).',
      inputSchema: {
        board: z.string().describe('board key or id'),
        column: z.string().optional().describe('column label or id'),
        assignee: z.string().optional().describe('member email, userSub, or "me"'),
        tag: z.string().optional().describe('tag name or id'),
        release: z.string().optional().describe('release name or id'),
        text: z.string().optional().describe('matches title + description'),
      },
    },
    async ({ board, ...f }) => {
      const boardId = await resolveBoardId(gql, board);
      const data = await gql(GET_BOARD, { boardId });
      const bc = data.getBoard;
      const ctx = buildContext(bc);
      // The filters still run against the FULL items — `text` matches bodies
      // server-side — but only the lean projection goes back over the wire.
      const filters = {
        ...f,
        ...(f.tag ? { tag: resolveTagIds(bc, [f.tag])[0] } : {}),
        ...(f.release ? { release: resolveReleaseId(bc, f.release) } : {}),
        ...(f.assignee ? { assignee: resolveAssignee(bc, f.assignee, botEmail) } : {}),
      };
      return toolText(filterItems(flattenBoard(bc), filters).map((i) => leanItem(i, ctx)));
    },
  );

  server.registerTool(
    'list_archived',
    {
      description: 'List archived items on a board, newest first.',
      inputSchema: { board: z.string().describe('board key or id') },
    },
    async ({ board }) => {
      const boardId = await resolveBoardId(gql, board);
      const [archived, boardData] = await Promise.all([
        gql(ARCHIVED_ITEMS, { boardId }),
        gql(GET_BOARD, { boardId }),
      ]);
      const bc = boardData.getBoard;
      const ctx = buildContext(bc);
      const labelOf = new Map<string, string>(
        (bc.board?.columns ?? []).map((c: any) => [c.id, c.label]),
      );
      const key: string | null = bc.board?.key ?? null;
      return toolText((archived.archivedItems ?? []).map((a: any) => {
        const raw = a.story ?? a.subtask;
        const lean = leanItem({
          kind: a.story ? 'story' : 'subtask',
          id: raw.id,
          storyId: a.subtask ? raw.storyId : undefined,
          ticket: key && typeof raw.num === 'number' ? `${key}-${raw.num}` : null,
          title: raw.title,
          columnId: raw.columnId,
          columnLabel: labelOf.get(raw.columnId) ?? raw.columnId,
          assignee: raw.assignee ?? null,
          tags: raw.tags ?? [],
          releaseId: raw.releaseId ?? null,
          snoozed: false,
          body: null,
        }, ctx);
        return { ...lean, archivedAt: a.archivedAt };
      }));
    },
  );
}
