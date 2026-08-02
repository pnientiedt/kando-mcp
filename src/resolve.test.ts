import { describe, it, expect } from 'vitest';
import {
  resolveColumnId,
  resolveTagIds,
  resolveReleaseId,
  resolveAssignee,
  resolveBlockedBy,
} from './resolve.js';
import { bc } from './shape.test.js';

describe('resolveColumnId', () => {
  it('matches a label case-insensitively', () => {
    expect(resolveColumnId(bc(), 'open')).toBe('open');
    expect(resolveColumnId(bc(), 'Done')).toBe('done');
  });

  it('passes a known id through', () => {
    expect(resolveColumnId(bc(), 'done')).toBe('done');
  });

  it('names the valid labels when unknown', () => {
    expect(() => resolveColumnId(bc(), 'Backlog')).toThrow(/Open.*Done/s);
  });
});

describe('resolveTagIds', () => {
  it('maps names to ids', () => {
    expect(resolveTagIds(bc(), ['refined', 'claude'])).toEqual(['t1', 't2']);
  });

  it('passes known ids through', () => {
    expect(resolveTagIds(bc(), ['t1'])).toEqual(['t1']);
  });

  it('points at ensure_tag for an unknown name, never auto-creating', () => {
    expect(() => resolveTagIds(bc(), ['nope'])).toThrow(/ensure_tag/);
  });

  it('accepts an empty list (clears all tags)', () => {
    expect(resolveTagIds(bc(), [])).toEqual([]);
  });
});

describe('resolveReleaseId', () => {
  it('maps a name to an id and passes "" through as a clear', () => {
    expect(resolveReleaseId(bc(), 'v1.0')).toBe('r1');
    expect(resolveReleaseId(bc(), '')).toBe('');
  });

  it('names the valid releases when unknown', () => {
    expect(() => resolveReleaseId(bc(), 'v9')).toThrow(/v1\.0/);
  });
});

describe('resolveAssignee', () => {
  it('resolves "me" to the authenticated bot', () => {
    expect(resolveAssignee(bc(), 'me', 'bot@example.com')).toBe('u1');
  });

  it('resolves an email and passes a known userSub through', () => {
    expect(resolveAssignee(bc(), 'BOT@example.com', null)).toBe('u1');
    expect(resolveAssignee(bc(), 'u1', null)).toBe('u1');
  });

  it('passes "" through as an unassign', () => {
    expect(resolveAssignee(bc(), '', null)).toBe('');
  });

  it('explains when "me" has no board membership', () => {
    expect(() => resolveAssignee(bc(), 'me', 'other@example.com')).toThrow(/not a member/i);
  });

  it('names the members when the value is unknown', () => {
    expect(() => resolveAssignee(bc(), 'nobody@x.com', null)).toThrow(/bot@example\.com/);
  });
});

describe('resolveBlockedBy', () => {
  const board = {
    board: { key: 'KDO', columns: [{ id: 'c1', label: 'Open', order: 0 }] },
    stories: [
      { id: 's1', num: 1, subtasks: [{ id: 'sub1', num: 2 }] },
      { id: 's2', num: 3, subtasks: [] },
    ],
  };

  it('turns KEY-N into ids, for stories and subtasks alike', () => {
    expect(resolveBlockedBy(board, ['KDO-1', 'KDO-2'])).toEqual(['s1', 'sub1']);
  });

  it('is case-insensitive on the key', () => {
    expect(resolveBlockedBy(board, ['kdo-3'])).toEqual(['s2']);
  });

  it('passes a raw id through when it names a board item', () => {
    expect(resolveBlockedBy(board, ['sub1'])).toEqual(['sub1']);
  });

  it('clears with an empty list', () => {
    expect(resolveBlockedBy(board, [])).toEqual([]);
  });

  it('refuses a ticket that is not on this board — dependencies are same-board', () => {
    expect(() => resolveBlockedBy(board, ['KDO-99'])).toThrow(/KDO-99/);
    expect(() => resolveBlockedBy(board, ['OTHER-1'])).toThrow(/same board/i);
  });

  it('refuses a self-reference', () => {
    expect(() => resolveBlockedBy(board, ['KDO-1'], 'KDO-1')).toThrow(/itself/i);
  });
});
