import { z } from 'zod';
import { type Gql, type ToolHost, toolText, resolveBoardId } from './read.js';
import { resolveTicketRef, type TicketRef } from '../tickets.js';
import { parsePosition, planReorder, POSITION_RULE, type Position } from '../reorder.js';
import { GET_BOARD } from '../operations.js';
import {
  CREATE_STORY,
  CREATE_SUBTASK,
  UPDATE_STORY,
  UPDATE_SUBTASK,
  DELETE_STORY,
  DELETE_SUBTASK,
  ARCHIVE_STORY,
  ARCHIVE_SUBTASK,
  UNARCHIVE_STORY,
  UNARCHIVE_SUBTASK,
} from '../operations.js';

export type TicketPatch = {
  title?: string;
  body?: string;
  tags?: string[];
  assignee?: string;
  releaseId?: string;
  estimateHours?: number;
  visibleAt?: string;
  excludedFromRelease?: boolean;
  column?: string;
  rank?: string;
};

/** Build the update op + variables, including ONLY provided fields. */
export function buildUpdateVars(ref: TicketRef, patch: TicketPatch) {
  const v: Record<string, unknown> = { boardId: ref.boardId, storyId: ref.storyId };
  const isSub = !!ref.subtaskId;
  if (isSub) v.subtaskId = ref.subtaskId;
  if (patch.column !== undefined) v.columnId = patch.column; // move → only columnId
  if (patch.rank !== undefined) v.rank = patch.rank; // reorder → only rank
  if (patch.title !== undefined) v.title = patch.title;
  if (patch.body !== undefined) v.body = patch.body;
  if (patch.tags !== undefined) v.tags = patch.tags;
  if (patch.assignee !== undefined) v.assignee = patch.assignee; // '' clears
  if (patch.releaseId !== undefined) v.releaseId = patch.releaseId; // '' clears
  if (patch.visibleAt !== undefined) v.visibleAt = patch.visibleAt; // '' clears
  if (patch.estimateHours !== undefined) v.estimateHours = patch.estimateHours;
  if (isSub && patch.excludedFromRelease !== undefined) v.excludedFromRelease = patch.excludedFromRelease;
  return { query: isSub ? UPDATE_SUBTASK : UPDATE_STORY, variables: v };
}

async function firstColumnId(gql: Gql, boardId: string): Promise<string> {
  const data = await gql(GET_BOARD, { boardId });
  const cols = [...(data.getBoard.board.columns ?? [])].sort((a: any, b: any) => a.order - b.order);
  if (!cols.length) throw new Error('board has no columns');
  return cols[0].id;
}

/** The `position` argument shared by create_story / create_subtask. */
const positionShape = z
  .object({
    to: z.enum(['top', 'bottom']).optional(),
    before: z.string().optional().describe('ticket KEY-N to sit directly above'),
    after: z.string().optional().describe('ticket KEY-N to sit directly below'),
  })
  .optional()
  .describe(`where to place it among its peers — ${POSITION_RULE}`);

/**
 * Rank a just-created (or existing) ticket at `position`, as a rank-ONLY update.
 * Deliberately not atomic with the create: `createStory`/`createSubtask` take no
 * rank, and the failure mode is benign — the ticket exists, at the bottom.
 */
async function applyPosition(gql: Gql, ref: TicketRef, position: Position) {
  const data = await gql(GET_BOARD, { boardId: ref.boardId });
  const rank = planReorder(data.getBoard, ref, position);
  const { query, variables } = buildUpdateVars(ref, { rank });
  const res = await gql(query, variables);
  return res.updateStory?.story ?? res.updateSubtask?.subtask;
}

export function registerTicketTools(server: ToolHost, gql: Gql) {
  server.registerTool(
    'create_story',
    {
      description: 'Create a standalone story on a board.',
      inputSchema: {
        board: z.string(),
        title: z.string(),
        column: z.string().optional().describe('column id; defaults to the first column'),
        body: z.string().optional(),
        tags: z.array(z.string()).optional(),
        assignee: z.string().optional(),
        releaseId: z.string().optional(),
        estimateHours: z.number().optional(),
        visibleAt: z.string().optional(),
        position: positionShape,
      },
    },
    async ({ board, column, position, ...rest }) => {
      const pos = position ? parsePosition(position) : null; // validate before creating anything
      const boardId = await resolveBoardId(gql, board);
      const columnId = column ?? (await firstColumnId(gql, boardId));
      const data = await gql(CREATE_STORY, { boardId, columnId, ...rest });
      const story = data.createStory.story;
      if (!pos) return toolText(story);
      const ref: TicketRef = { boardId, storyId: story.id };
      return toolText((await applyPosition(gql, ref, pos)) ?? story);
    },
  );

  server.registerTool(
    'create_subtask',
    {
      description: 'Create a subtask under a parent story (turns a standalone story into a container).',
      inputSchema: {
        parent: z.string().describe('parent ticket KEY-N'),
        title: z.string(),
        column: z.string().optional(),
        body: z.string().optional(),
        tags: z.array(z.string()).optional(),
        assignee: z.string().optional(),
        releaseId: z.string().optional(),
        estimateHours: z.number().optional(),
        excludedFromRelease: z.boolean().optional(),
        visibleAt: z.string().optional(),
        position: positionShape,
      },
    },
    async ({ parent, column, position, ...rest }) => {
      const pos = position ? parsePosition(position) : null; // validate before creating anything
      const ref = await resolveTicketRef(gql, parent);
      const storyId = ref.subtaskId ? undefined : ref.storyId;
      if (!storyId) throw new Error('parent must be a story ticket, not a subtask');
      const columnId = column ?? (await firstColumnId(gql, ref.boardId));
      const data = await gql(CREATE_SUBTASK, { boardId: ref.boardId, storyId, columnId, ...rest });
      const subtask = data.createSubtask.subtask;
      if (!pos) return toolText(subtask);
      const subRef: TicketRef = { boardId: ref.boardId, storyId, subtaskId: subtask.id };
      return toolText((await applyPosition(gql, subRef, pos)) ?? subtask);
    },
  );

  const patchShape = {
    title: z.string().optional(),
    body: z.string().optional(),
    tags: z.array(z.string()).optional(),
    assignee: z.string().optional().describe("member userSub; '' to unassign"),
    releaseId: z.string().optional().describe("release id; '' to clear"),
    estimateHours: z.number().optional(),
    visibleAt: z.string().optional().describe("ISO datetime to snooze until; '' to unsnooze"),
    excludedFromRelease: z.boolean().optional().describe('subtasks only'),
    column: z.string().optional().describe('target column id (moves the ticket)'),
  };

  server.registerTool(
    'update_ticket',
    {
      description: 'Edit a ticket (title/body/tags/assignee/release/estimate/snooze/column).',
      inputSchema: { ticket: z.string(), ...patchShape },
    },
    async ({ ticket, ...patch }) => {
      const ref = await resolveTicketRef(gql, ticket);
      const { query, variables } = buildUpdateVars(ref, patch);
      const data = await gql(query, variables);
      return toolText(data.updateStory?.story ?? data.updateSubtask?.subtask);
    },
  );

  server.registerTool(
    'move_ticket',
    {
      description: 'Move a ticket to a column (status change). Sends only the column.',
      inputSchema: { ticket: z.string(), column: z.string().describe('target column id') },
    },
    async ({ ticket, column }) => {
      const ref = await resolveTicketRef(gql, ticket);
      const { query, variables } = buildUpdateVars(ref, { column });
      const data = await gql(query, variables);
      return toolText(data.updateStory?.story ?? data.updateSubtask?.subtask);
    },
  );

  server.registerTool(
    'reorder_ticket',
    {
      description:
        'Position a ticket within its peer group (priority order), without changing anything else — ' +
        `${POSITION_RULE}. Peers are: a subtask → its parent story's subtasks in the same column; ` +
        'a standalone story → the standalone stories in its column; a container story → the board\'s lanes. ' +
        'Sends only the new rank. Use move_ticket to change a column.',
      inputSchema: {
        ticket: z.string(),
        to: z.enum(['top', 'bottom']).optional().describe('top or bottom of its peer group'),
        before: z.string().optional().describe('ticket KEY-N to sit directly above'),
        after: z.string().optional().describe('ticket KEY-N to sit directly below'),
      },
    },
    async ({ ticket, to, before, after }) => {
      const position = parsePosition({ to, before, after }); // validate before any network call
      const ref = await resolveTicketRef(gql, ticket);
      return toolText(await applyPosition(gql, ref, position));
    },
  );

  server.registerTool(
    'archive_ticket',
    {
      description: 'Archive a ticket (reversible; preferred over delete).',
      inputSchema: { ticket: z.string() },
    },
    async ({ ticket }) => {
      const ref = await resolveTicketRef(gql, ticket);
      if (ref.subtaskId) {
        await gql(ARCHIVE_SUBTASK, { boardId: ref.boardId, storyId: ref.storyId, subtaskId: ref.subtaskId });
      } else {
        await gql(ARCHIVE_STORY, { boardId: ref.boardId, storyId: ref.storyId });
      }
      return toolText({ archived: ticket });
    },
  );

  server.registerTool(
    'unarchive_ticket',
    {
      description: 'Restore an archived ticket.',
      inputSchema: { ticket: z.string() },
    },
    async ({ ticket }) => {
      const ref = await resolveTicketRef(gql, ticket);
      if (ref.subtaskId) {
        const d = await gql(UNARCHIVE_SUBTASK, {
          boardId: ref.boardId,
          storyId: ref.storyId,
          subtaskId: ref.subtaskId,
        });
        return toolText(d.unarchiveSubtask.subtask);
      }
      const d = await gql(UNARCHIVE_STORY, { boardId: ref.boardId, storyId: ref.storyId });
      return toolText(d.unarchiveStory.story);
    },
  );

  server.registerTool(
    'delete_ticket',
    {
      description: 'Permanently delete a ticket. Prefer archive_ticket unless a hard delete is intended.',
      inputSchema: { ticket: z.string() },
    },
    async ({ ticket }) => {
      const ref = await resolveTicketRef(gql, ticket);
      if (ref.subtaskId) {
        await gql(DELETE_SUBTASK, { boardId: ref.boardId, storyId: ref.storyId, subtaskId: ref.subtaskId });
      } else {
        await gql(DELETE_STORY, { boardId: ref.boardId, storyId: ref.storyId });
      }
      return toolText({ deleted: ticket });
    },
  );
}
