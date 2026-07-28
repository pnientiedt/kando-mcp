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

export type TicketRef = { boardId: string; storyId?: string; subtaskId?: string };

export async function resolveTicketRef(gql: GqlClient, input: string): Promise<TicketRef> {
  const { key, num } = parseTicketId(input);
  const data = await gql(RESOLVE_TICKET, { key, num });
  return data.resolveTicket as TicketRef;
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
