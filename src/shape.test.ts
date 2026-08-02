import { describe, it, expect } from 'vitest';
import { buildContext, leanItem, leanDetail, leanComments, ack } from './shape.js';
import type { FlatItem } from './tickets.js';

/** A board container shaped like getBoard's payload. Shared with resolve.test.ts. */
export function bc() {
  return {
    board: {
      id: 'b1',
      key: 'KDO',
      name: 'Kando',
      role: 'EDITOR',
      columns: [
        { id: 'open', label: 'Open', order: 0 },
        { id: 'done', label: 'Done', order: 1 },
      ],
    },
    stories: [
      {
        id: 's1',
        num: 1,
        columnId: 'open',
        archivedAt: null,
        subtasks: [{ id: 'sub1', num: 22, columnId: 'open', archivedAt: null }],
      },
    ],
    tags: [
      { id: 't1', name: 'refined' },
      { id: 't2', name: 'claude' },
    ],
    releases: [{ id: 'r1', name: 'v1.0', targetDate: '2026-08-01' }],
    members: [{ userSub: 'u1', email: 'bot@example.com', displayName: 'Bot', role: 'EDITOR' }],
  };
}

const item = (over: Partial<FlatItem> = {}): FlatItem => ({
  kind: 'subtask',
  id: 'sub1',
  storyId: 's1',
  ticket: 'KDO-22',
  title: 'Backend foundation',
  columnId: 'open',
  columnLabel: 'Open',
  assignee: null,
  tags: [],
  releaseId: null,
  snoozed: false,
  body: 'a very long spec',
  ...over,
});

describe('leanItem', () => {
  it('drops the body and every empty field', () => {
    expect(
      leanItem(item({ storyId: undefined, kind: 'story', ticket: 'KDO-1' }), buildContext(bc())),
    ).toEqual({ ticket: 'KDO-1', title: 'Backend foundation', col: 'Open' });
  });

  it('resolves tag ids to names, assignee to email, release to name, parent to KEY-N', () => {
    expect(
      leanItem(
        item({ tags: ['t1', 't2'], assignee: 'u1', releaseId: 'r1', snoozed: true }),
        buildContext(bc()),
      ),
    ).toEqual({
      ticket: 'KDO-22',
      title: 'Backend foundation',
      col: 'Open',
      parent: 'KDO-1',
      tags: ['refined', 'claude'],
      assignee: 'bot@example.com',
      snoozed: true,
      release: 'v1.0',
    });
  });

  it('falls back to the raw id when a tag or member is unknown', () => {
    const lean = leanItem(item({ tags: ['gone'], assignee: 'ghost' }), buildContext(bc()));
    expect(lean.tags).toEqual(['gone']);
    expect(lean.assignee).toBe('ghost');
  });
});

describe('ack', () => {
  it('is the ticket plus only what changed', () => {
    expect(ack('KDO-54', { col: 'In Progress' })).toEqual({ ticket: 'KDO-54', col: 'In Progress' });
  });
});

describe('leanDetail', () => {
  const raw = {
    id: 's1',
    num: 1,
    title: 'Batched deploys',
    body: 'FULL SPEC',
    columnId: 'open',
    tags: ['t1'],
    assignee: 'u1',
    releaseId: 'r1',
    estimateHours: 4,
    visibleAt: null,
  };

  it('keeps the body — this is the one tool that explains', () => {
    const d = leanDetail(raw, buildContext(bc()), {
      kind: 'story',
      ticket: 'KDO-1',
      columnLabel: 'Open',
    });
    expect(d).toEqual({
      ticket: 'KDO-1',
      kind: 'story',
      title: 'Batched deploys',
      col: 'Open',
      body: 'FULL SPEC',
      tags: ['refined'],
      assignee: 'bot@example.com',
      release: 'v1.0',
      estimateHours: 4,
    });
  });

  it("lists a container's subtasks leanly — no sibling bodies", () => {
    const sub: FlatItem = {
      kind: 'subtask',
      id: 'sub1',
      storyId: 's1',
      ticket: 'KDO-22',
      title: 'Sub',
      columnId: 'open',
      columnLabel: 'Open',
      assignee: null,
      tags: [],
      releaseId: null,
      snoozed: false,
      body: 'SIBLING SPEC',
    };
    const d = leanDetail(raw, buildContext(bc()), {
      kind: 'story',
      ticket: 'KDO-1',
      columnLabel: 'Open',
      subtasks: [sub],
    });
    expect(d.subtasks).toEqual([
      { ticket: 'KDO-22', title: 'Sub', col: 'Open', parent: 'KDO-1' },
    ]);
    expect(JSON.stringify(d.subtasks)).not.toContain('SIBLING SPEC');
  });

  it('surfaces the creator as an email — provenance survives the trim (TSK-52)', () => {
    const d = leanDetail({ ...raw, creator: 'u1' }, buildContext(bc()), {
      kind: 'story',
      ticket: 'KDO-1',
      columnLabel: 'Open',
    });
    expect(d.creator).toBe('bot@example.com');
  });

  it('carries visibleAt when snoozed and parent for a subtask', () => {
    const d = leanDetail({ ...raw, visibleAt: '2099-01-01T00:00:00Z' }, buildContext(bc()), {
      kind: 'subtask',
      ticket: 'KDO-22',
      columnLabel: 'Open',
      parent: 'KDO-1',
    });
    expect(d.visibleAt).toBe('2099-01-01T00:00:00Z');
    expect(d.parent).toBe('KDO-1');
  });

  it('names the blockers and flags an unresolved one', () => {
    const d = leanDetail(raw, buildContext(bc()), {
      kind: 'story',
      ticket: 'KDO-1',
      columnLabel: 'Open',
      blockers: { list: ['KDO-7', 'KDO-9'], blocked: true },
    });
    expect(d.blockedBy).toEqual(['KDO-7', 'KDO-9']);
    expect(d.blocked).toBe(true);
  });

  it('keeps a resolved dependency listed but drops the blocked flag', () => {
    // The association is part of the record: KDO-7 being Done is not a reason
    // to forget the ticket was ordered behind it.
    const d = leanDetail(raw, buildContext(bc()), {
      kind: 'story',
      ticket: 'KDO-1',
      columnLabel: 'Open',
      blockers: { list: ['KDO-7'], blocked: false },
    });
    expect(d.blockedBy).toEqual(['KDO-7']);
    expect(d).not.toHaveProperty('blocked');
  });

  it('emits neither field when there are no dependencies', () => {
    const d = leanDetail(raw, buildContext(bc()), {
      kind: 'story',
      ticket: 'KDO-1',
      columnLabel: 'Open',
      blockers: { list: [], blocked: false },
    });
    expect(d).not.toHaveProperty('blockedBy');
    expect(d).not.toHaveProperty('blocked');
  });
});

describe('leanComments', () => {
  const ctx = buildContext({
    board: { key: 'KDO', columns: [] },
    stories: [],
    tags: [],
    releases: [],
    members: [{ userSub: 'u1', email: 'bot@example.com' }],
  });

  const c = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    author: 'u1',
    text: `text ${id}`,
    createdAt: '2026-07-28T10:00:00.000Z',
    editedAt: null,
    ...over,
  });

  it('renders a comment with its key, author email, timestamp and text', () => {
    const { comments, earlier } = leanComments([c('KDO-34-1')], ctx);
    expect(earlier).toBe(0);
    expect(comments).toEqual([
      {
        comment: 'KDO-34-1',
        author: 'bot@example.com',
        at: '2026-07-28T10:00:00.000Z',
        text: 'text KDO-34-1',
      },
    ]);
  });

  it('falls back to the raw sub when the author is not a board member', () => {
    const { comments } = leanComments([c('KDO-34-1', { author: 'ghost' })], ctx);
    expect(comments[0].author).toBe('ghost');
  });

  it('marks an edited comment and omits the flag otherwise', () => {
    const { comments } = leanComments(
      [c('KDO-34-1'), c('KDO-34-2', { editedAt: '2026-07-28T11:00:00.000Z' })],
      ctx,
    );
    expect(comments[0]).not.toHaveProperty('edited');
    expect(comments[1].edited).toBe(true);
  });

  it('returns nothing for a ticket with no comments', () => {
    expect(leanComments([], ctx)).toEqual({ comments: [], earlier: 0 });
  });

  it('is uncapped when no cap is given', () => {
    const raw = Array.from({ length: 25 }, (_, i) => c(`KDO-34-${i + 1}`));
    const { comments, earlier } = leanComments(raw, ctx);
    expect(comments).toHaveLength(25);
    expect(earlier).toBe(0);
  });

  it('keeps the last N in oldest-first order and reports how many it dropped', () => {
    const raw = Array.from({ length: 11 }, (_, i) => c(`KDO-34-${i + 1}`));
    const { comments, earlier } = leanComments(raw, ctx, 10);
    expect(earlier).toBe(1);
    expect(comments).toHaveLength(10);
    expect(comments[0].comment).toBe('KDO-34-2');
    expect(comments[9].comment).toBe('KDO-34-11');
  });

  it('drops nothing when the count equals the cap', () => {
    const raw = Array.from({ length: 10 }, (_, i) => c(`KDO-34-${i + 1}`));
    const { comments, earlier } = leanComments(raw, ctx, 10);
    expect(comments).toHaveLength(10);
    expect(earlier).toBe(0);
  });

  it('renders keys with gaps as-is and never renumbers them', () => {
    const { comments } = leanComments([c('KDO-34-1'), c('KDO-34-4'), c('KDO-34-5')], ctx);
    expect(comments.map((x) => x.comment)).toEqual(['KDO-34-1', 'KDO-34-4', 'KDO-34-5']);
  });
});
