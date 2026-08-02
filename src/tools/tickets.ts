import { z } from 'zod';
import { KandoError } from '../graphql.js';
import { type Gql, type ToolHost, toolText, resolveBoardId } from './read.js';
import { resolveTicketRef, requireLive, requireArchived, type TicketIds } from '../tickets.js';
import { parsePosition, planReorder, POSITION_RULE, type Position } from '../reorder.js';
import { ack } from '../shape.js';
import {
  resolveColumnId,
  resolveTagIds,
  resolveReleaseId,
  resolveAssignee,
  resolveBlockedBy,
} from '../resolve.js';
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
  blockedBy?: string[];
};

/** Build the update op + variables, including ONLY provided fields. */
export function buildUpdateVars(ref: TicketIds, patch: TicketPatch) {
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
  if (patch.blockedBy !== undefined) v.blockedBy = patch.blockedBy; // [] clears every dependency
  if (isSub && patch.excludedFromRelease !== undefined) v.excludedFromRelease = patch.excludedFromRelease;
  return { query: isSub ? UPDATE_SUBTASK : UPDATE_STORY, variables: v };
}

/**
 * Resolve every human-readable input on a patch to its id, fetching the board at
 * most once and only when something actually needs resolving. Also returns the
 * column LABEL, which is what the ack echoes — no second round trip to read it back.
 */
async function resolvePatch(
  gql: Gql,
  boardId: string,
  patch: TicketPatch,
  botEmail: string | null,
  // The ticket being edited, so a dependency on ITSELF can be refused by name.
  selfTicket?: string,
): Promise<{ patch: TicketPatch; colLabel?: string }> {
  const needs =
    patch.column !== undefined ||
    patch.tags !== undefined ||
    patch.blockedBy !== undefined ||
    (patch.assignee !== undefined && patch.assignee !== '') ||
    (patch.releaseId !== undefined && patch.releaseId !== '');
  if (!needs) return { patch };
  const bc = (await gql(GET_BOARD, { boardId })).getBoard;
  const out: TicketPatch = { ...patch };
  let colLabel: string | undefined;
  if (patch.column !== undefined) {
    out.column = resolveColumnId(bc, patch.column);
    colLabel = (bc.board?.columns ?? []).find((c: any) => c.id === out.column)?.label ?? out.column;
  }
  if (patch.tags !== undefined) out.tags = resolveTagIds(bc, patch.tags);
  if (patch.assignee !== undefined) out.assignee = resolveAssignee(bc, patch.assignee, botEmail);
  if (patch.releaseId !== undefined) out.releaseId = resolveReleaseId(bc, patch.releaseId);
  if (patch.blockedBy !== undefined) out.blockedBy = resolveBlockedBy(bc, patch.blockedBy, selfTicket);
  return { patch: out, colLabel };
}

/** The board plus its rank-sorted columns — creates need both. */
async function boardForCreate(gql: Gql, boardId: string) {
  const bc = (await gql(GET_BOARD, { boardId })).getBoard;
  const cols = [...(bc.board.columns ?? [])].sort((a: any, b: any) => a.order - b.order);
  if (!cols.length) throw new Error('board has no columns');
  return { bc, cols };
}

/** Shared by create_story / create_subtask: resolve column + registry inputs once. */
function createVars(
  bc: any,
  cols: any[],
  column: string | undefined,
  rest: Record<string, any>,
  botEmail: string | null,
) {
  const columnId = column ? resolveColumnId(bc, column) : cols[0].id;
  const colLabel = cols.find((c: any) => c.id === columnId)?.label ?? columnId;
  const vars: Record<string, unknown> = { columnId, ...rest };
  if (rest.tags !== undefined) vars.tags = resolveTagIds(bc, rest.tags);
  if (rest.assignee !== undefined) vars.assignee = resolveAssignee(bc, rest.assignee, botEmail);
  if (rest.releaseId !== undefined) vars.releaseId = resolveReleaseId(bc, rest.releaseId);
  // A brand-new ticket has no id yet, so no self-reference is possible.
  if (rest.blockedBy !== undefined) vars.blockedBy = resolveBlockedBy(bc, rest.blockedBy);
  return { vars, colLabel };
}

/**
 * The `blockedBy` argument, identical on all three write tools (KDO-94).
 * A list, so `[]` is its own natural "none" — unlike the scalar fields, which
 * clear with `''`.
 */
const blockedByShape = z
  .array(z.string())
  .optional()
  .describe('ticket KEY-Ns on the SAME board that must be Done first; [] clears them');

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
async function applyPosition(gql: Gql, ref: TicketIds, position: Position) {
  const data = await gql(GET_BOARD, { boardId: ref.boardId });
  const rank = planReorder(data.getBoard, ref, position);
  const { query, variables } = buildUpdateVars(ref, { rank });
  const res = await gql(query, variables);
  return res.updateStory?.story ?? res.updateSubtask?.subtask;
}

export function registerTicketTools(server: ToolHost, gql: Gql, botEmail: string | null = null) {
  server.registerTool(
    'create_story',
    {
      description: 'Create a standalone story on a board.',
      inputSchema: {
        board: z.string(),
        title: z.string(),
        column: z.string().optional().describe('column label or id; defaults to the first column'),
        body: z.string().optional(),
        tags: z.array(z.string()).optional().describe('tag NAMES (or ids); create unknown tags with ensure_tag first'),
        assignee: z.string().optional().describe('member email, userSub, or "me"'),
        releaseId: z.string().optional().describe('release name or id'),
        estimateHours: z.number().optional(),
        visibleAt: z.string().optional(),
        blockedBy: blockedByShape,
        position: positionShape,
      },
    },
    async ({ board, column, position, ...rest }) => {
      const pos = position ? parsePosition(position) : null; // validate before creating anything
      const boardId = await resolveBoardId(gql, board);
      const { bc, cols } = await boardForCreate(gql, boardId);
      const { vars, colLabel } = createVars(bc, cols, column, rest, botEmail);
      const data = await gql(CREATE_STORY, { boardId, ...vars });
      const story = data.createStory.story;
      if (pos) await applyPosition(gql, { boardId, storyId: story.id }, pos);
      const key = bc.board?.key ?? null;
      const ticket = key && typeof story.num === 'number' ? `${key}-${story.num}` : null;
      return toolText({ ticket, title: rest.title, col: colLabel });
    },
  );

  server.registerTool(
    'create_subtask',
    {
      description: 'Create a subtask under a parent story (turns a standalone story into a container).',
      inputSchema: {
        parent: z.string().describe('parent ticket KEY-N'),
        title: z.string(),
        column: z.string().optional().describe('column label or id; defaults to the first column'),
        body: z.string().optional(),
        tags: z.array(z.string()).optional().describe('tag NAMES (or ids); create unknown tags with ensure_tag first'),
        assignee: z.string().optional().describe('member email, userSub, or "me"'),
        releaseId: z.string().optional().describe('release name or id'),
        estimateHours: z.number().optional(),
        excludedFromRelease: z.boolean().optional(),
        visibleAt: z.string().optional(),
        blockedBy: blockedByShape,
        position: positionShape,
      },
    },
    async ({ parent, column, position, ...rest }) => {
      const pos = position ? parsePosition(position) : null; // validate before creating anything
      const ref = requireLive(await resolveTicketRef(gql, parent), parent);
      const storyId = ref.subtaskId ? undefined : ref.storyId;
      if (!storyId) throw new Error('parent must be a story ticket, not a subtask');
      const { bc, cols } = await boardForCreate(gql, ref.boardId);
      const { vars, colLabel } = createVars(bc, cols, column, rest, botEmail);
      const data = await gql(CREATE_SUBTASK, { boardId: ref.boardId, storyId, ...vars });
      const subtask = data.createSubtask.subtask;
      if (pos) {
        const subRef: TicketIds = { boardId: ref.boardId, storyId, subtaskId: subtask.id };
        await applyPosition(gql, subRef, pos);
      }
      const key = bc.board?.key ?? null;
      const ticket = key && typeof subtask.num === 'number' ? `${key}-${subtask.num}` : null;
      return toolText({ ticket, title: rest.title, col: colLabel, parent });
    },
  );

  const patchShape = {
    title: z.string().optional(),
    body: z.string().optional(),
    tags: z.array(z.string()).optional().describe('tag NAMES (or ids); create unknown tags with ensure_tag first'),
    assignee: z.string().optional().describe("member email, userSub, or \"me\"; '' to unassign"),
    releaseId: z.string().optional().describe("release name or id; '' to clear"),
    estimateHours: z.number().optional(),
    visibleAt: z.string().optional().describe("ISO datetime to snooze until; '' to unsnooze"),
    excludedFromRelease: z.boolean().optional().describe('subtasks only'),
    column: z.string().optional().describe('target column label or id (moves the ticket)'),
    blockedBy: blockedByShape,
  };

  server.registerTool(
    'update_ticket',
    {
      description:
        'Edit a ticket (title/body/tags/assignee/release/estimate/snooze/column/blockedBy). ' +
        'blockedBy takes ticket KEY-Ns on the same board that must be Done before this one is workable; ' +
        'pass [] to clear them.',
      inputSchema: { ticket: z.string(), ...patchShape },
    },
    async ({ ticket, ...raw }) => {
      // Editing something off the board is almost never what was meant, and half
      // this patch surface (column, rank, release progress) has no meaning while
      // archived. Say so instead of writing invisibly.
      const ref = requireLive(await resolveTicketRef(gql, ticket), ticket);
      const changed = Object.keys(raw).filter((k) => (raw as any)[k] !== undefined);
      const { patch } = await resolvePatch(gql, ref.boardId, raw as TicketPatch, botEmail, ticket);
      const { query, variables } = buildUpdateVars(ref, patch);
      await gql(query, variables);
      return toolText(ack(ticket, { updated: changed }));
    },
  );

  server.registerTool(
    'move_ticket',
    {
      description: 'Move a ticket to a column (status change). Sends only the column.',
      inputSchema: { ticket: z.string(), column: z.string().describe('target column label or id') },
    },
    async ({ ticket, column }) => {
      const ref = requireLive(await resolveTicketRef(gql, ticket), ticket);
      const { patch, colLabel } = await resolvePatch(gql, ref.boardId, { column }, botEmail);
      const { query, variables } = buildUpdateVars(ref, patch);
      await gql(query, variables);
      return toolText(ack(ticket, { col: colLabel ?? column }));
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
      const ref = requireLive(await resolveTicketRef(gql, ticket), ticket);
      await applyPosition(gql, ref, position);
      return toolText(ack(ticket, { position: to ?? (before ? `before ${before}` : `after ${after}`) }));
    },
  );

  server.registerTool(
    'archive_ticket',
    {
      description:
        'Archive a ticket (reversible; preferred over delete). Archiving a story ' +
        'archives its subtasks with it.',
      inputSchema: { ticket: z.string() },
    },
    async ({ ticket }) => {
      const ref = await resolveTicketRef(gql, ticket);
      if (ref.archived) {
        throw new KandoError(
          `${ticket} is already archived. Use unarchive_ticket to restore it.`,
          'ARCHIVED',
        );
      }
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
      description:
        'Restore an archived ticket to the board, body intact. Restores that ticket ' +
        'ONLY: a story comes back standalone, and any subtask archived with it stays ' +
        'archived until unarchived by name (list_archived shows them).',
      inputSchema: { ticket: z.string() },
    },
    async ({ ticket }) => {
      // The one tool whose target is archived by definition — and the one that
      // could never succeed before KDO-90, because resolving it 404'd.
      const ref = requireArchived(await resolveTicketRef(gql, ticket), ticket);
      if (ref.subtaskId) {
        await gql(UNARCHIVE_SUBTASK, {
          boardId: ref.boardId,
          storyId: ref.storyId,
          subtaskId: ref.subtaskId,
        });
      } else {
        await gql(UNARCHIVE_STORY, { boardId: ref.boardId, storyId: ref.storyId });
      }
      return toolText({ unarchived: ticket });
    },
  );

  server.registerTool(
    'delete_ticket',
    {
      description: 'Permanently delete a ticket. Prefer archive_ticket unless a hard delete is intended.',
      inputSchema: { ticket: z.string() },
    },
    async ({ ticket }) => {
      // Deliberately NOT guarded on archived: purging something already archived
      // is the normal path, and making the caller restore it to the board first
      // just to delete it would be perverse.
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
