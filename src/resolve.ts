import { KandoError } from './graphql.js';

/**
 * The outputs no longer carry UUIDs, so the inputs must accept what the outputs
 * show. Each resolver takes a board container plus whatever the caller typed and
 * returns an id — or throws naming the valid options, which is the only way a
 * model recovers from a typo without a second round trip.
 */

const bad = (msg: string) => new KandoError(msg, 'BAD_INPUT');
const eq = (a: unknown, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();

/** A column label (case-insensitive) or a column id. */
export function resolveColumnId(bc: any, value: string): string {
  const cols = bc?.board?.columns ?? [];
  const byId = cols.find((c: any) => c.id === value);
  if (byId) return byId.id;
  const hits = cols.filter((c: any) => eq(c.label, value));
  if (hits.length === 1) return hits[0].id;
  if (hits.length > 1) throw bad(`Column "${value}" is ambiguous on this board; pass its id instead.`);
  const labels = cols.map((c: any) => `"${c.label}"`).join(', ');
  throw bad(`No column "${value}" on this board. Columns are: ${labels}.`);
}

/** Tag names (case-insensitive) or tag ids. An unknown NAME is an error, never an auto-create. */
export function resolveTagIds(bc: any, values: string[]): string[] {
  const tags = bc?.tags ?? [];
  return values.map((v) => {
    const byId = tags.find((t: any) => t.id === v);
    if (byId) return byId.id;
    const hits = tags.filter((t: any) => eq(t.name, v));
    if (hits.length === 1) return hits[0].id;
    if (hits.length > 1) throw bad(`Tag "${v}" is ambiguous on this board; pass its id instead.`);
    const names = tags.map((t: any) => `"${t.name}"`).join(', ') || '(none yet)';
    throw bad(`No tag "${v}" on this board. Existing tags: ${names}. Create it with ensure_tag first.`);
  });
}

/** A release name or id. '' clears the field and passes straight through. */
export function resolveReleaseId(bc: any, value: string): string {
  if (value === '') return '';
  const rels = bc?.releases ?? [];
  const byId = rels.find((r: any) => r.id === value);
  if (byId) return byId.id;
  const hits = rels.filter((r: any) => eq(r.name, value));
  if (hits.length === 1) return hits[0].id;
  if (hits.length > 1) throw bad(`Release "${value}" is ambiguous on this board; pass its id instead.`);
  const names = rels.map((r: any) => `"${r.name}"`).join(', ') || '(none yet)';
  throw bad(`No release "${value}" on this board. Existing releases: ${names}.`);
}

/**
 * An email, a userSub, or "me" — the account the server is authenticated as.
 * "me" is what frees the loop coordinator from caching a userSub at all.
 * '' clears the assignee and passes straight through.
 */
export function resolveAssignee(bc: any, value: string, botEmail: string | null): string {
  if (value === '') return '';
  const members = bc?.members ?? [];
  const isMe = eq(value, 'me');
  const wanted = isMe ? (botEmail ?? '') : value;
  if (isMe && !wanted) {
    throw bad('This server has no authenticated account, so "me" cannot be resolved.');
  }
  const byId = members.find((m: any) => m.userSub === wanted);
  if (byId) return byId.userSub;
  const hit = members.find((m: any) => eq(m.email, wanted));
  if (hit) return hit.userSub;
  const emails = members.map((m: any) => m.email).join(', ') || '(none)';
  if (isMe) {
    throw bad(`The authenticated account (${wanted}) is not a member of this board. Members: ${emails}.`);
  }
  throw bad(`No member "${value}" on this board. Members: ${emails}.`);
}

/**
 * Blocking dependencies (KDO-94), addressed as KEY-N like everything else. A
 * raw item id passes through when it names something on this board, so an id
 * read back out of a ticket can be handed straight back in.
 *
 * Dependencies are SAME-BOARD by construction — the backend stores bare ids
 * with no board — so a KEY-N this board does not contain is refused rather
 * than stored as a reference that can never resolve. An empty list clears
 * every dependency; that is a list's own natural "none", unlike the ''-clears
 * convention the scalar fields use.
 */
export function resolveBlockedBy(bc: any, values: string[], selfTicket?: string): string[] {
  const key: string | null = bc?.board?.key ?? null;
  const items: Array<{ id: string; num: unknown }> = [];
  for (const s of bc?.stories ?? []) {
    items.push({ id: s.id, num: s.num });
    for (const sub of s.subtasks ?? []) items.push({ id: sub.id, num: sub.num });
  }
  const self = selfTicket?.toUpperCase();
  return values.map((v) => {
    const raw = v.trim();
    if (self && raw.toUpperCase() === self) {
      throw bad(`${raw} cannot be blocked by itself.`);
    }
    const byId = items.find((i) => i.id === raw);
    if (byId) return byId.id;
    const m = raw.match(/^([A-Za-z]{1,10})-(\d+)$/);
    if (!m) throw bad(`"${raw}" is not a ticket id (expected KEY-N, e.g. KDO-7).`);
    if (key && m[1].toUpperCase() !== key.toUpperCase()) {
      throw bad(`${raw} is not on this board (${key}). A blockedBy dependency must be on the same board.`);
    }
    const hit = items.find((i) => i.num === Number(m[2]));
    if (!hit) throw bad(`No ticket ${raw} on this board. A blockedBy dependency must be on the same board.`);
    return hit.id;
  });
}
