import { z } from 'zod';
import { KandoError, type GqlClient } from '../graphql.js';
import { MY_BOARDS, GET_BOARD, ARCHIVED_ITEMS } from '../operations.js';
import { flattenBoard, filterItems, resolveTicketRef } from '../tickets.js';
import { buildContext, leanItem, leanDetail } from '../shape.js';
import { resolveTagIds, resolveReleaseId, resolveAssignee } from '../resolve.js';

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
      description: 'Get a board with its columns, non-archived tickets, tags, releases and members.',
      inputSchema: {
        board: z.string().describe('board key (e.g. TSK) or id'),
        fields: z
          .array(z.enum(['board', 'items', 'tags', 'releases', 'members']))
          .optional()
          .describe('sections to return; omit for all. Use ["board","members"] for just columns + userSubs.'),
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
      description: 'Get full detail for one ticket by KEY-N.',
      inputSchema: { ticket: z.string().describe('ticket id, e.g. TSK-42') },
    },
    async ({ ticket }) => {
      const ref = await resolveTicketRef(gql, ticket);
      const data = await gql(GET_BOARD, { boardId: ref.boardId });
      const bc = data.getBoard;
      const ctx = buildContext(bc);
      const labelOf = new Map<string, string>(
        (bc.board?.columns ?? []).map((c: any) => [c.id, c.label]),
      );
      const story = (bc.stories ?? []).find((s: any) => s.id === ref.storyId);
      if (!story) throw new KandoError('That story no longer exists.', 'NOT_FOUND');
      if (ref.subtaskId) {
        const sub = (story.subtasks ?? []).find((x: any) => x.id === ref.subtaskId);
        if (!sub) throw new KandoError('That subtask no longer exists.', 'NOT_FOUND');
        return toolText(leanDetail(sub, ctx, {
          kind: 'subtask',
          ticket: ctx.ticketOf.get(sub.id) ?? null,
          columnLabel: labelOf.get(sub.columnId) ?? sub.columnId,
          parent: ctx.ticketOf.get(story.id),
        }));
      }
      // Reuse flattenBoard so the subtask list obeys the same archived rules as
      // every other list, then keep only this story's children.
      const subs = flattenBoard(bc).filter((i) => i.storyId === story.id);
      return toolText(leanDetail(story, ctx, {
        kind: 'story',
        ticket: ctx.ticketOf.get(story.id) ?? null,
        columnLabel: labelOf.get(story.columnId) ?? story.columnId,
        subtasks: subs.length ? subs : undefined,
      }));
    },
  );

  server.registerTool(
    'search_tickets',
    {
      description: "Search a board's non-archived tickets. Filters combine with AND.",
      inputSchema: {
        board: z.string().describe('board key or id'),
        column: z.string().optional().describe('column label or id'),
        assignee: z.string().optional().describe('member userSub'),
        tag: z.string().optional().describe('tag id'),
        release: z.string().optional().describe('release id'),
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
