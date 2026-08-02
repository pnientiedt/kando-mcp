/**
 * KDO-93 `getTickets`: the two mappings that stand between the tool's inputs and
 * the wire, and between a `TicketSummary` and a lean row. Pure — hand it plain
 * objects and it hands plain objects back, no server involved.
 *
 * Enums are lowercase at the tool boundary and UPPERCASE on the wire: the suite's
 * rule is that everything is addressed the way it is displayed, and `ARCHIVED` is
 * wire vocabulary.
 *
 * Nothing the caller did not set is ever sent. The defaults for `archived`,
 * `snoozed`, `tagMode` and `limit` live in the backend's `validate.ts` and
 * nowhere else, so they cannot drift out of step with a second copy here.
 */

export type SearchInput = {
  tags?: string[];
  tagMode?: 'any' | 'all';
  releases?: string[];
  assignees?: string[];
  columns?: string[];
  text?: string;
  kind?: 'story' | 'subtask';
  archived?: 'live' | 'archived' | 'all';
  snoozed?: 'show' | 'hide' | 'only';
};

/** An empty list means "no filter on this field" — never "match nothing". */
const list = (v: string[] | undefined): string[] | undefined => (v && v.length ? v : undefined);

export function buildTicketFilter(input: SearchInput, boardIds?: string[]): Record<string, unknown> {
  const f: Record<string, unknown> = {};
  const ids = list(boardIds);
  if (ids) f.boardIds = ids;
  const tags = list(input.tags);
  if (tags) {
    f.tags = tags;
    // tagMode qualifies `tags`; alone it would be a filter on nothing.
    if (input.tagMode) f.tagMode = input.tagMode.toUpperCase();
  }
  const releases = list(input.releases);
  if (releases) f.releases = releases;
  const assignees = list(input.assignees);
  if (assignees) f.assignees = assignees; // raw userSub or the "me" sentinel
  const columns = list(input.columns);
  if (columns) f.columns = columns;
  if (input.text) f.text = input.text;
  if (input.kind) f.kind = input.kind.toUpperCase();
  if (input.archived) f.archived = input.archived.toUpperCase();
  if (input.snoozed) f.snoozed = input.snoozed.toUpperCase();
  return f;
}

export type LeanRow = {
  ticket: string | null;
  title: string;
  col: string;
  parent?: string;
  tags?: string[];
  assignee?: string;
  snoozed?: boolean;
  release?: string;
  subtasks?: number;
  archivedAt?: string;
};

/**
 * One `TicketSummary` as a lean row, in the same vocabulary `leanItem` uses so a
 * search result reads like every other list. Empty fields are omitted rather than
 * emitted as null — across 100 rows the nulls cost more than the values.
 *
 * No board field: `ticket` is `KEY-N` and the key names the board, so a board
 * column would repeat itself on every row of a cross-board result.
 */
export function leanSummary(s: any): LeanRow {
  const out: LeanRow = { ticket: s.ticket ?? null, title: s.title, col: s.columnLabel };
  if (s.parent) out.parent = s.parent;
  if (s.tags?.length) out.tags = s.tags;
  const assignee = s.assigneeEmail ?? s.assignee;
  if (assignee) out.assignee = assignee;
  if (typeof s.visibleAt === 'string' && Date.parse(s.visibleAt) > Date.now()) out.snoozed = true;
  if (s.releaseName) out.release = s.releaseName;
  // >0 is what distinguishes a CONTAINER from a standalone — the difference
  // between moving the story and moving its subtasks.
  if (s.subtaskCount > 0) out.subtasks = s.subtaskCount;
  // The sort is by KEY-N, so recency is no longer conveyed by position.
  if (s.archivedAt) out.archivedAt = s.archivedAt;
  return out;
}
