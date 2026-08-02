import { KandoError, type GqlClient } from './graphql.js';
import { RESOLVE_TICKET } from './operations.js';

export function parseTicketId(input: string): { key: string; num: number } {
  const m = input.trim().match(/^([A-Za-z]{1,10})-(\d+)$/);
  if (!m) {
    throw new KandoError(`Not a ticket id (expected KEY-N, e.g. TSK-42): "${input}"`, 'BAD_INPUT');
  }
  return { key: m[1].toUpperCase(), num: Number(m[2]) };
}

/**
 * A comment's id IS its key: `KDO-34-3` is the third comment on `KDO-34`. The
 * ordinal is a persisted, monotonic per-item counter — a delete neither renumbers
 * the comments after it nor frees the number — so the key addresses one comment
 * for the life of the ticket. That is what lets the write tools pass it straight
 * through as `commentId` instead of fetching the list to translate a position.
 */
export function parseCommentKey(input: string): { ticket: string; commentId: string } {
  const m = input.trim().match(/^([A-Za-z]{1,10})-(\d+)-(\d+)$/);
  if (!m) {
    throw new KandoError(
      `Not a comment key: "${input}". Expected KEY-N-M, e.g. KDO-34-3.`,
      'BAD_INPUT',
    );
  }
  const ticket = `${m[1].toUpperCase()}-${m[2]}`;
  return { ticket, commentId: `${ticket}-${m[3]}` };
}

/** Just the addressing. What a mutation needs to name its target row. */
export type TicketIds = { boardId: string; storyId?: string; subtaskId?: string };

export type TicketRef = TicketIds & {
  /** Resolved, but NOT on the board. Archived is a state, not an absence. */
  archived: boolean;
};

export async function resolveTicketRef(gql: GqlClient, input: string): Promise<TicketRef> {
  const { key, num } = parseTicketId(input);
  const data = await gql(RESOLVE_TICKET, { key, num });
  const ref = data.resolveTicket as TicketRef;
  // A server predating KDO-90 omits the field — and never resolved an archived
  // ticket at all, so absent can only mean live. Normalise so no caller has to
  // distinguish `false` from `undefined` when deciding whether to write.
  return { ...ref, archived: Boolean(ref?.archived) };
}

/**
 * A ticket that resolves is not necessarily on the board.
 *
 * Before KDO-90 every write tool got this guarantee for free: `resolveTicket`
 * 404'd archived tickets, so nothing could edit one. Now that they resolve, a
 * tool that changes a ticket's place in the workflow has to say no itself —
 * otherwise it silently mutates something the caller cannot see.
 *
 * The wording matters as much as the guard. NOT_FOUND's "no longer exists" reads
 * as *deleted*, which is what sent KDO-90's reporter looking for a ticket that
 * was sitting in the archive intact.
 */
export function requireLive(ref: TicketRef, ticket: string): TicketRef {
  if (ref.archived) {
    throw new KandoError(
      `${ticket} is archived, not deleted — it still exists, but it is off the board. ` +
        'Restore it with unarchive_ticket first, or read it with get_ticket.',
      'ARCHIVED',
    );
  }
  return ref;
}

/** The mirror image: unarchive_ticket only ever has work to do on an archived ticket. */
export function requireArchived(ref: TicketRef, ticket: string): TicketRef {
  if (!ref.archived) {
    throw new KandoError(`${ticket} is not archived — it is already on the board.`, 'NOT_ARCHIVED');
  }
  return ref;
}

export type FlatItem = {
  kind: 'story' | 'subtask';
  id: string;
  storyId?: string;
  ticket: string | null;
  title: string;
  columnId: string;
  columnLabel: string;
  assignee: string | null;
  tags: string[];
  releaseId: string | null;
  snoozed: boolean;
  body: string | null;
};

const isSnoozed = (visibleAt: unknown): boolean =>
  typeof visibleAt === 'string' && Date.parse(visibleAt) > Date.now();

export function flattenBoard(board: any): FlatItem[] {
  const key: string | null = board.board?.key ?? null;
  const labelOf = new Map<string, string>(
    (board.board?.columns ?? []).map((c: any) => [c.id, c.label]),
  );
  const ticketOf = (num: unknown) => (key && typeof num === 'number' ? `${key}-${num}` : null);
  const out: FlatItem[] = [];
  for (const s of board.stories ?? []) {
    if (s.archivedAt) continue;
    out.push({
      kind: 'story',
      id: s.id,
      ticket: ticketOf(s.num),
      title: s.title,
      columnId: s.columnId,
      columnLabel: labelOf.get(s.columnId) ?? s.columnId,
      assignee: s.assignee ?? null,
      tags: s.tags ?? [],
      releaseId: s.releaseId ?? null,
      snoozed: isSnoozed(s.visibleAt),
      body: s.body ?? null,
    });
    for (const sub of s.subtasks ?? []) {
      if (sub.archivedAt) continue;
      out.push({
        kind: 'subtask',
        id: sub.id,
        storyId: s.id,
        ticket: ticketOf(sub.num),
        title: sub.title,
        columnId: sub.columnId,
        columnLabel: labelOf.get(sub.columnId) ?? sub.columnId,
        assignee: sub.assignee ?? null,
        tags: sub.tags ?? [],
        releaseId: sub.releaseId ?? null,
        snoozed: isSnoozed(sub.visibleAt),
        body: sub.body ?? null,
      });
    }
  }
  return out;
}

export function filterItems(
  items: FlatItem[],
  f: { column?: string; assignee?: string; tag?: string; release?: string; text?: string },
): FlatItem[] {
  const col = f.column?.toLowerCase();
  const text = f.text?.toLowerCase();
  return items.filter((i) => {
    if (col && i.columnLabel.toLowerCase() !== col && i.columnId.toLowerCase() !== col) return false;
    if (f.assignee && i.assignee !== f.assignee) return false;
    if (f.tag && !i.tags.includes(f.tag)) return false;
    if (f.release && i.releaseId !== f.release) return false;
    if (text && !`${i.title} ${i.body ?? ''}`.toLowerCase().includes(text)) return false;
    return true;
  });
}
