import { z } from 'zod';
import { KandoError, type GqlClient } from '../graphql.js';
import { MY_BOARDS, GET_BOARD, ARCHIVED_ITEMS } from '../operations.js';
import { flattenBoard, filterItems, resolveTicketRef } from '../tickets.js';

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

export function toolText(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
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

export function registerReadTools(server: ToolHost, gql: Gql) {
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
      inputSchema: { board: z.string().describe('board key (e.g. TSK) or id') },
    },
    async ({ board }) => {
      const boardId = await resolveBoardId(gql, board);
      const data = await gql(GET_BOARD, { boardId });
      const bc = data.getBoard;
      return toolText({
        board: {
          id: bc.board.id,
          key: bc.board.key,
          name: bc.board.name,
          role: bc.board.role,
          columns: [...(bc.board.columns ?? [])].sort((a: any, c: any) => a.order - c.order),
        },
        items: flattenBoard(bc),
        tags: bc.tags,
        releases: bc.releases,
        members: (bc.members ?? []).map((m: any) => ({
          userSub: m.userSub,
          email: m.email,
          displayName: m.displayName,
          role: m.role,
        })),
      });
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
      if (ref.subtaskId) {
        const parent = (bc.stories ?? []).find((s: any) => s.id === ref.storyId);
        const sub = (parent?.subtasks ?? []).find((x: any) => x.id === ref.subtaskId);
        if (!sub) throw new KandoError('That subtask no longer exists.', 'NOT_FOUND');
        return toolText({ kind: 'subtask', parentStoryId: ref.storyId, ...sub });
      }
      const story = (bc.stories ?? []).find((s: any) => s.id === ref.storyId);
      if (!story) throw new KandoError('That story no longer exists.', 'NOT_FOUND');
      return toolText({ kind: 'story', ...story });
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
      return toolText(filterItems(flattenBoard(data.getBoard), f));
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
      const data = await gql(ARCHIVED_ITEMS, { boardId });
      return toolText(data.archivedItems);
    },
  );
}
