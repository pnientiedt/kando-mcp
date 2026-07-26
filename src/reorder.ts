import { KandoError } from './graphql.js';
import { rankBetween } from './rank.js';
import { parseTicketId, type TicketRef } from './tickets.js';

/**
 * Pure rank planning for `reorder_ticket` (KDO-40) — no network, no MCP types.
 * Everything here reads the `getBoard` payload the caller already fetched, so
 * the whole "where does this ticket go?" decision is unit-testable.
 */

export type Position = { to: 'top' | 'bottom' } | { before: string } | { after: string };

/** Anything on the board that carries a rank and can be a peer. */
export type Rankable = {
  id: string;
  num?: number | null;
  rank: string;
  columnId: string;
  storyId?: string | null;
};

/** The three groupings a rank is meaningful within — see `peerGroup`. */
export type PeerKind = 'subtask' | 'standalone' | 'lane';

export const POSITION_RULE =
  "exactly one of `to` ('top'|'bottom'), `before` (KEY-N) or `after` (KEY-N) is required";

/** Validate the mutually-exclusive position args. Throws BAD_INPUT otherwise. */
export function parsePosition(input: {
  to?: string | null;
  before?: string | null;
  after?: string | null;
}): Position {
  const given = (['to', 'before', 'after'] as const).filter(
    (k) => input[k] !== undefined && input[k] !== null && input[k] !== '',
  );
  if (given.length !== 1) {
    throw new KandoError(
      `Cannot position the ticket: ${POSITION_RULE} (got ${given.length === 0 ? 'none' : given.join(' + ')}).`,
      'BAD_INPUT',
    );
  }
  if (given[0] === 'to') {
    const to = input.to as string;
    if (to !== 'top' && to !== 'bottom') {
      throw new KandoError(`\`to\` must be 'top' or 'bottom' (got "${to}").`, 'BAD_INPUT');
    }
    return { to };
  }
  return given[0] === 'before'
    ? { before: input.before as string }
    : { after: input.after as string };
}

const live = (x: { archivedAt?: string | null }) => !x.archivedAt;
const isContainer = (s: any) => (s.subtasks ?? []).filter(live).length > 0;
const byRank = (a: Rankable, b: Rankable) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0);

function findSelf(bc: any, ref: TicketRef): { self: Rankable; story: any } {
  const story = (bc.stories ?? []).find((s: any) => s.id === ref.storyId);
  if (!story) throw new KandoError('That story no longer exists.', 'NOT_FOUND');
  if (!ref.subtaskId) return { self: story as Rankable, story };
  const sub = (story.subtasks ?? []).find((x: any) => x.id === ref.subtaskId);
  if (!sub) throw new KandoError('That subtask no longer exists.', 'NOT_FOUND');
  return { self: sub as Rankable, story };
}

/**
 * The items a ticket is visibly ranked against — a rank is only meaningful
 * within its group, so "top" has to mean top of something. Mirrors how the
 * board renders (`cellItems` / `storiesSorted` in web/src/lib/swimlanes.ts):
 *
 *  - **subtask** → its parent story's non-archived subtasks in the SAME column
 *  - **standalone story** (0 subtasks) → non-archived standalone stories in the SAME column
 *  - **container story** (≥1 subtask) → non-archived container stories BOARD-WIDE (lane order)
 *
 * Peers are sorted by rank and never include the moving ticket itself —
 * otherwise "top" would be computed against its own current rank.
 */
export function peerGroup(bc: any, ref: TicketRef): { self: Rankable; peers: Rankable[]; kind: PeerKind } {
  const { self, story } = findSelf(bc, ref);
  const stories = (bc.stories ?? []).filter(live);
  let peers: Rankable[];
  let kind: PeerKind;
  if (ref.subtaskId) {
    kind = 'subtask';
    peers = (story.subtasks ?? []).filter((s: any) => live(s) && s.columnId === self.columnId);
  } else if (isContainer(story)) {
    kind = 'lane';
    peers = stories.filter(isContainer);
  } else {
    kind = 'standalone';
    peers = stories.filter((s: any) => !isContainer(s) && s.columnId === self.columnId);
  }
  return { self, peers: peers.filter((p) => p.id !== self.id).sort(byRank), kind };
}

/** Resolve a `before`/`after` KEY-N against the board payload we already have. */
function resolveTarget(bc: any, ticket: string, self: Rankable, peers: Rankable[], kind: PeerKind): Rankable {
  const { key, num } = parseTicketId(ticket);
  const boardKey: string | null = bc.board?.key ?? null;
  if (boardKey && key !== boardKey) {
    throw new KandoError(
      `${ticket} is not on this board (${boardKey}) — a ticket can only be positioned relative to one of its own peers.`,
      'BAD_INPUT',
    );
  }
  if (self.num === num) {
    throw new KandoError(`Cannot position ${ticket} relative to itself.`, 'BAD_INPUT');
  }
  const target = peers.find((p) => p.num === num);
  if (target) return target;

  // Not a peer: say why, in terms the caller can act on. Each branch has to be
  // true of the TARGET — advice about the wrong thing is worse than none.
  const onBoard = allRankables(bc).find((r) => r.item.num === num);
  if (!onBoard) {
    throw new KandoError(`${ticket} is not on this board, or is archived.`, 'NOT_FOUND');
  }
  if (onBoard.kind !== kind) {
    // Different groups entirely — a move cannot make these two peers.
    throw new KandoError(
      `${ticket} is a ${KIND_LABEL[onBoard.kind]} and this ticket ranks as a ${KIND_LABEL[kind]}, so they are not peers. ` +
        'Subtasks rank within their parent story and column; standalone stories rank within their column; container stories rank as lanes.',
      'BAD_INPUT',
    );
  }
  // Same group, so only a column or a parent can be in the way. (Lanes rank
  // board-wide: every other lane is already a peer, so this is unreachable for
  // them — which is exactly why the column advice must not be given to a lane.)
  if (onBoard.item.columnId !== self.columnId) {
    throw new KandoError(
      `${ticket} is in a different column (${onBoard.item.columnId}) — move the ticket there first, then position it.`,
      'BAD_INPUT',
    );
  }
  throw new KandoError(
    `${ticket} belongs to a different story — subtasks rank within their parent story, ` +
      "so position this one relative to one of its own story's subtasks.",
    'BAD_INPUT',
  );
}

const KIND_LABEL: Record<PeerKind, string> = {
  subtask: 'subtask',
  standalone: 'standalone story',
  lane: 'container story (a lane)',
};

/** Every non-archived item on the board, tagged with the peer group it ranks in. */
function allRankables(bc: any): Array<{ item: Rankable; kind: PeerKind }> {
  const out: Array<{ item: Rankable; kind: PeerKind }> = [];
  for (const s of (bc.stories ?? []).filter(live)) {
    out.push({ item: s as Rankable, kind: isContainer(s) ? 'lane' : 'standalone' });
    for (const sub of (s.subtasks ?? []).filter(live)) out.push({ item: sub as Rankable, kind: 'subtask' });
  }
  return out;
}

/**
 * The rank that puts `ref` at `position` within its peer group. Pure: the
 * caller passes the `getBoard` payload and sends the result as a rank-only
 * update, so nothing else on the ticket can be touched.
 */
export function planReorder(bc: any, ref: TicketRef, position: Position): string {
  const { self, peers, kind } = peerGroup(bc, ref);
  if ('to' in position) {
    return position.to === 'top'
      ? rankBetween(null, peers[0]?.rank ?? null)
      : rankBetween(peers[peers.length - 1]?.rank ?? null, null);
  }
  const ticket = 'before' in position ? position.before : position.after;
  const target = resolveTarget(bc, ticket, self, peers, kind);
  const at = peers.indexOf(target);
  return 'before' in position
    ? rankBetween(peers[at - 1]?.rank ?? null, target.rank)
    : rankBetween(target.rank, peers[at + 1]?.rank ?? null);
}
