import { describe, it, expect } from 'vitest';
import { buildContext, leanItem, leanDetail, ack } from './shape.js';
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
});
