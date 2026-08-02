import { describe, it, expect, vi } from 'vitest';
import {
  parseTicketId,
  parseCommentKey,
  resolveTicketRef,
  requireLive,
  requireArchived,
  flattenBoard,
  filterItems,
} from './tickets.js';

describe('parseTicketId', () => {
  it('parses KEY-N', () => {
    expect(parseTicketId('TSK-42')).toEqual({ key: 'TSK', num: 42 });
    expect(parseTicketId('tsk-7')).toEqual({ key: 'TSK', num: 7 });
  });
  it('rejects garbage', () => {
    expect(() => parseTicketId('nope')).toThrow();
    expect(() => parseTicketId('TSK-')).toThrow();
  });
});

describe('parseCommentKey', () => {
  it('splits a comment key into its ticket and the full key', () => {
    expect(parseCommentKey('KDO-34-3')).toEqual({ ticket: 'KDO-34', commentId: 'KDO-34-3' });
  });

  it('uppercases the board key so lowercase input still addresses the right comment', () => {
    expect(parseCommentKey('kdo-34-3')).toEqual({ ticket: 'KDO-34', commentId: 'KDO-34-3' });
  });

  it('trims surrounding whitespace', () => {
    expect(parseCommentKey('  KDO-34-3  ')).toEqual({ ticket: 'KDO-34', commentId: 'KDO-34-3' });
  });

  it('rejects a plain ticket id, naming the expected shape', () => {
    expect(() => parseCommentKey('KDO-34')).toThrow(/Not a comment key.*KEY-N-M/s);
  });

  it('rejects a non-numeric ordinal', () => {
    expect(() => parseCommentKey('KDO-34-x')).toThrow(/Not a comment key/);
  });

  it('rejects a key with no board key', () => {
    expect(() => parseCommentKey('34-1')).toThrow(/Not a comment key/);
  });
});

describe('resolveTicketRef', () => {
  it('calls resolveTicket with parsed parts', async () => {
    const gql = vi.fn(async () => ({
      resolveTicket: { boardId: 'b1', storyId: 's1', subtaskId: null, archived: false },
    }));
    const ref = await resolveTicketRef(gql as never, 'TSK-42');
    expect(ref).toEqual({ boardId: 'b1', storyId: 's1', subtaskId: null, archived: false });
    expect(gql).toHaveBeenCalledWith(expect.any(String), { key: 'TSK', num: 42 });
  });

  it('carries the archived flag through to callers', async () => {
    const gql = vi.fn(async () => ({
      resolveTicket: { boardId: 'b1', storyId: 's1', subtaskId: null, archived: true },
    }));
    expect(await resolveTicketRef(gql as never, 'TSK-42')).toMatchObject({ archived: true });
  });

  it('reads a backend that predates the archived field as live', async () => {
    // Before KDO-90 the server never resolved an archived ticket at all, so a
    // missing flag can only mean a live one. Absent must not read as undefined.
    const gql = vi.fn(async () => ({ resolveTicket: { boardId: 'b1', storyId: 's1' } }));
    expect((await resolveTicketRef(gql as never, 'TSK-42')).archived).toBe(false);
  });
});

describe('requireLive', () => {
  const live = { boardId: 'b1', storyId: 's1', archived: false };
  const gone = { boardId: 'b1', storyId: 's1', archived: true };

  it('passes a live ref straight through', () => {
    expect(requireLive(live, 'TSK-42')).toBe(live);
  });

  it('names the ticket as archived — never as deleted', () => {
    expect(() => requireLive(gone, 'TSK-42')).toThrow(/TSK-42.*archived/i);
    // The whole point of KDO-90: "no longer exists" reads as gone and misleads.
    expect(() => requireLive(gone, 'TSK-42')).not.toThrow(/no longer exists/i);
  });

  it('points at the way out', () => {
    expect(() => requireLive(gone, 'TSK-42')).toThrow(/unarchive_ticket/);
  });
});

describe('requireArchived', () => {
  it('passes an archived ref through', () => {
    const ref = { boardId: 'b1', storyId: 's1', archived: true };
    expect(requireArchived(ref, 'TSK-42')).toBe(ref);
  });

  it('refuses to pretend it restored a ticket that was never archived', () => {
    expect(() => requireArchived({ boardId: 'b1', storyId: 's1', archived: false }, 'TSK-42')).toThrow(
      /not archived/i,
    );
  });
});

const board = {
  board: {
    key: 'TSK',
    columns: [
      { id: 'c1', label: 'To Do', order: 0 },
      { id: 'c2', label: 'Done', order: 1 },
    ],
  },
  stories: [
    {
      id: 's1', num: 1, title: 'Login', body: 'oauth', columnId: 'c1', tags: ['bug'], assignee: 'u1',
      releaseId: 'r1', visibleAt: null, archivedAt: null,
      subtasks: [
        { id: 'sub1', num: 2, title: 'Form', body: null, columnId: 'c1', tags: [], assignee: null,
          releaseId: null, visibleAt: '2999-01-01T00:00:00Z', archivedAt: null },
        { id: 'sub2', num: 3, title: 'Archived', columnId: 'c2', tags: [], archivedAt: '2020-01-01T00:00:00Z' },
      ],
    },
    { id: 's2', num: 4, title: 'Gone', columnId: 'c1', tags: [], archivedAt: '2020-01-01T00:00:00Z', subtasks: [] },
  ],
};

describe('flattenBoard', () => {
  it('drops archived, builds KEY-N and column labels, flags snooze', () => {
    const items = flattenBoard(board);
    expect(items.map((i) => i.ticket)).toEqual(['TSK-1', 'TSK-2']);
    expect(items[0].columnLabel).toBe('To Do');
    expect(items[1].snoozed).toBe(true);
  });
});

describe('filterItems', () => {
  it('filters by column label, tag, assignee, release, and text', () => {
    const items = flattenBoard(board);
    expect(filterItems(items, { column: 'to do' }).length).toBe(2);
    expect(filterItems(items, { tag: 'bug' }).map((i) => i.ticket)).toEqual(['TSK-1']);
    expect(filterItems(items, { assignee: 'u1' }).map((i) => i.ticket)).toEqual(['TSK-1']);
    expect(filterItems(items, { text: 'oauth' }).map((i) => i.ticket)).toEqual(['TSK-1']);
    expect(filterItems(items, { release: 'r1' }).map((i) => i.ticket)).toEqual(['TSK-1']);
  });
});
