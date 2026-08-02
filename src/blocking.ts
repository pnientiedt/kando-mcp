/**
 * Blocking dependencies (KDO-94). A story or subtask carries `blockedBy`: the
 * ids of SAME-BOARD items that must be finished first. Everything here is pure
 * — hand it a board container and it answers, no server involved.
 *
 * ONE rule, in `buildBlockerIndex`, decides whether a blocker still stands:
 *
 *   - absent from the board  -> RESOLVED. `getBoard` drops archived rows, and a
 *     hard delete cascade-strips inbound refs (the backend's `dependencies.ts`),
 *     so absent means archived or gone — neither stands in the way. This is the
 *     same guard the web UI applies before rendering a dependency chip.
 *   - in the LAST column     -> RESOLVED (Done).
 *   - anything else          -> it blocks.
 *
 * A CONTAINER blocker is judged by its subtasks, never by its own `columnId`:
 * a story with subtasks has no authoritative column of its own (its status is
 * derived), so Done means every live subtask sits in the last column — the
 * first branch of the backend's `deriveColumnId`. This is the only place the
 * MCP derives container status.
 */

export type BlockerIndex = {
  /** item id → its KEY-N (null when the board key or num is missing). */
  ticketOf: Map<string, string | null>;
  /** Blockers that still stand. Resolved ids are simply absent. */
  unresolved: Set<string>;
  /** item id → num, so KEY-N output sorts numerically rather than as text. */
  numOf: Map<string, number>;
};

export function buildBlockerIndex(bc: any): BlockerIndex {
  const cols = [...(bc?.board?.columns ?? [])].sort((a: any, b: any) => a.order - b.order);
  const lastCol: string | null = cols.length ? cols[cols.length - 1].id : null;
  const key: string | null = bc?.board?.key ?? null;
  const ticketOf = new Map<string, string | null>();
  const numOf = new Map<string, number>();
  const unresolved = new Set<string>();

  const register = (item: any, done: boolean) => {
    ticketOf.set(item.id, key && typeof item.num === 'number' ? `${key}-${item.num}` : null);
    if (typeof item.num === 'number') numOf.set(item.id, item.num);
    if (!done) unresolved.add(item.id);
  };

  for (const s of bc?.stories ?? []) {
    const subs = (s.subtasks ?? []).filter((sub: any) => !sub.archivedAt);
    // A container is Done when every live subtask is; a standalone story by its
    // own column. `lastCol` is null only on a column-less board, where nothing
    // can be Done and equally nothing is worth blocking — treat all as resolved.
    const storyDone =
      lastCol == null
        ? true
        : subs.length
          ? subs.every((sub: any) => sub.columnId === lastCol)
          : s.columnId === lastCol;
    register(s, storyDone);
    for (const sub of subs) register(sub, lastCol == null ? true : sub.columnId === lastCol);
  }
  return { ticketOf, unresolved, numOf };
}

/** Sort ids by their ticket number and render them as KEY-N, dropping unknowns. */
function asTickets(ids: string[], index: BlockerIndex): string[] {
  return [...new Set(ids)]
    .filter((id) => index.ticketOf.has(id))
    .sort((a, b) => (index.numOf.get(a) ?? 0) - (index.numOf.get(b) ?? 0))
    .map((id) => index.ticketOf.get(id))
    .filter((t): t is string => t != null);
}

/**
 * The blockers still standing in the way of working `item`, as KEY-N.
 *
 * `parent` is the item's CONTAINER story (null for a standalone story) and its
 * blockers count as the subtask's own: work units are standalone stories and
 * subtasks — never a container itself — so a dependency drawn on a container
 * would otherwise mean nothing at all.
 */
export function unresolvedBlockers(item: any, parent: any | null, index: BlockerIndex): string[] {
  const ids = [...(item?.blockedBy ?? []), ...(parent?.blockedBy ?? [])];
  return asTickets(
    ids.filter((id: string) => index.unresolved.has(id)),
    index,
  );
}

/**
 * Every blocker of `item` ITSELF that still exists on the board, resolved or
 * not — the ticket's record of what it was ordered behind. Inheritance is
 * deliberately not applied: this answers "what did someone link here?".
 */
export function blockerTickets(item: any, index: BlockerIndex): string[] {
  return asTickets([...(item?.blockedBy ?? [])], index);
}
