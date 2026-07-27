import type { FlatItem } from './tickets.js';

/**
 * Shaping a response is a separate concern from fetching one. Everything here is
 * pure: give it a board container and an item, it hands back what the caller should
 * see. That is what makes the "lists identify, get_ticket explains" rule testable
 * without a server.
 */

export type BoardCtx = {
  tagName: Map<string, string>;
  releaseName: Map<string, string>;
  memberEmail: Map<string, string>;
  /** item id → KEY-N, for rendering a subtask's parent. */
  ticketOf: Map<string, string>;
};

/** Build the id→human-readable lookups a lean response needs. One pass over the board. */
export function buildContext(bc: any): BoardCtx {
  const key: string | null = bc?.board?.key ?? null;
  const ticketOf = new Map<string, string>();
  for (const s of bc?.stories ?? []) {
    if (key && typeof s.num === 'number') ticketOf.set(s.id, `${key}-${s.num}`);
    for (const sub of s.subtasks ?? []) {
      if (key && typeof sub.num === 'number') ticketOf.set(sub.id, `${key}-${sub.num}`);
    }
  }
  return {
    tagName: new Map((bc?.tags ?? []).map((t: any) => [t.id, t.name])),
    releaseName: new Map((bc?.releases ?? []).map((r: any) => [r.id, r.name])),
    memberEmail: new Map((bc?.members ?? []).map((m: any) => [m.userSub, m.email])),
    ticketOf,
  };
}

export type LeanItem = {
  ticket: string | null;
  title: string;
  col: string;
  parent?: string;
  tags?: string[];
  assignee?: string;
  snoozed?: boolean;
  release?: string;
};

/**
 * A list entry: enough to identify and triage a ticket, never its body.
 * Empty fields are omitted rather than emitted as null — on a 60-item board the
 * nulls cost more than the values do.
 */
export function leanItem(i: FlatItem, ctx: BoardCtx): LeanItem {
  const out: LeanItem = { ticket: i.ticket, title: i.title, col: i.columnLabel };
  const parent = i.storyId ? ctx.ticketOf.get(i.storyId) : undefined;
  if (parent) out.parent = parent;
  if (i.tags?.length) out.tags = i.tags.map((t) => ctx.tagName.get(t) ?? t);
  if (i.assignee) out.assignee = ctx.memberEmail.get(i.assignee) ?? i.assignee;
  if (i.snoozed) out.snoozed = true;
  if (i.releaseId) out.release = ctx.releaseName.get(i.releaseId) ?? i.releaseId;
  return out;
}

export type DetailOpts = {
  kind: 'story' | 'subtask';
  ticket: string | null;
  columnLabel: string;
  parent?: string;
  subtasks?: FlatItem[];
};

/**
 * The ONE response that carries a body. A container lists its subtasks leanly:
 * you asked about this ticket, not its siblings' specs.
 */
export function leanDetail(raw: any, ctx: BoardCtx, o: DetailOpts): Record<string, unknown> {
  const out: Record<string, unknown> = {
    ticket: o.ticket,
    kind: o.kind,
    title: raw.title,
    col: o.columnLabel,
  };
  if (o.parent) out.parent = o.parent;
  out.body = raw.body ?? null;
  if (raw.tags?.length) out.tags = raw.tags.map((t: string) => ctx.tagName.get(t) ?? t);
  if (raw.assignee) out.assignee = ctx.memberEmail.get(raw.assignee) ?? raw.assignee;
  if (raw.releaseId) out.release = ctx.releaseName.get(raw.releaseId) ?? raw.releaseId;
  // Provenance (TSK-52) belongs in the response that explains a ticket, not in
  // the lists that merely identify one.
  if (raw.creator) out.creator = ctx.memberEmail.get(raw.creator) ?? raw.creator;
  if (raw.estimateHours != null) out.estimateHours = raw.estimateHours;
  if (raw.visibleAt) out.visibleAt = raw.visibleAt;
  if (raw.excludedFromRelease) out.excludedFromRelease = true;
  if (o.subtasks) out.subtasks = o.subtasks.map((s) => leanItem(s, ctx));
  return out;
}

/** A mutation confirmation: the ticket plus only what changed. */
export function ack(ticket: string, changed: Record<string, unknown>) {
  return { ticket, ...changed };
}
