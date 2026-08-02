import { describe, it, expect } from 'vitest';
import { buildBlockerIndex, unresolvedBlockers, blockerTickets } from './blocking.js';

/**
 * Three columns; `c3` is Done. `s1` is an open standalone, `s2` a Done
 * standalone, `s3` a container whose subtasks are both Done, `s4` a container
 * with one subtask still open.
 */
function board() {
  return {
    board: {
      key: 'KDO',
      columns: [
        { id: 'c1', label: 'To Do', order: 0 },
        { id: 'c2', label: 'Doing', order: 1 },
        { id: 'c3', label: 'Done', order: 2 },
      ],
    },
    stories: [
      { id: 's1', num: 1, columnId: 'c1', blockedBy: [], subtasks: [] },
      { id: 's2', num: 2, columnId: 'c3', blockedBy: [], subtasks: [] },
      {
        id: 's3', num: 3, columnId: 'c2', blockedBy: [],
        subtasks: [
          { id: 'sub1', num: 4, columnId: 'c3', blockedBy: [] },
          { id: 'sub2', num: 5, columnId: 'c3', blockedBy: [] },
        ],
      },
      {
        id: 's4', num: 6, columnId: 'c2', blockedBy: [],
        subtasks: [
          { id: 'sub3', num: 7, columnId: 'c3', blockedBy: [] },
          { id: 'sub4', num: 8, columnId: 'c1', blockedBy: [] },
        ],
      },
    ],
  };
}

describe('buildBlockerIndex / unresolvedBlockers', () => {
  it('a blocker in the last column is resolved', () => {
    const i = buildBlockerIndex(board());
    expect(unresolvedBlockers({ id: 'x', blockedBy: ['s2'] }, null, i)).toEqual([]);
  });

  it('a blocker anywhere else blocks, named as KEY-N', () => {
    const i = buildBlockerIndex(board());
    expect(unresolvedBlockers({ id: 'x', blockedBy: ['s1'] }, null, i)).toEqual(['KDO-1']);
  });

  it('a blocker that is not on the board (archived or deleted) is resolved', () => {
    const i = buildBlockerIndex(board());
    expect(unresolvedBlockers({ id: 'x', blockedBy: ['gone'] }, null, i)).toEqual([]);
  });

  it('a container blocker is resolved only when EVERY live subtask is Done', () => {
    const i = buildBlockerIndex(board());
    expect(unresolvedBlockers({ id: 'x', blockedBy: ['s3'] }, null, i)).toEqual([]);
    expect(unresolvedBlockers({ id: 'x', blockedBy: ['s4'] }, null, i)).toEqual(['KDO-6']);
  });

  it("a subtask inherits its container story's blockers", () => {
    const i = buildBlockerIndex(board());
    const sub = { id: 'x', blockedBy: [] };
    const parent = { id: 's3', blockedBy: ['s1'] };
    expect(unresolvedBlockers(sub, parent, i)).toEqual(['KDO-1']);
  });

  it('reports own and inherited blockers together, sorted by num, de-duplicated', () => {
    const i = buildBlockerIndex(board());
    const out = unresolvedBlockers(
      { id: 'x', blockedBy: ['s4', 's1'] },
      { id: 's3', blockedBy: ['s1'] },
      i,
    );
    expect(out).toEqual(['KDO-1', 'KDO-6']);
  });

  it('is empty for an item with no blockedBy at all (pre-KDO-94 shape)', () => {
    const i = buildBlockerIndex(board());
    expect(unresolvedBlockers({ id: 'x' }, null, i)).toEqual([]);
    expect(blockerTickets({ id: 'x' }, i)).toEqual([]);
  });

  it('a board with no columns resolves nothing and blocks nothing', () => {
    const i = buildBlockerIndex({ board: { key: 'KDO', columns: [] }, stories: [] });
    expect(unresolvedBlockers({ id: 'x', blockedBy: ['s1'] }, null, i)).toEqual([]);
  });
});

describe('blockerTickets', () => {
  it('lists every LIVE blocker of the item itself, resolved or not, sorted by num', () => {
    const i = buildBlockerIndex(board());
    expect(blockerTickets({ id: 'x', blockedBy: ['s2', 'gone', 's1'] }, i)).toEqual(['KDO-1', 'KDO-2']);
  });

  it("does not inherit the parent's blockers — that is unresolvedBlockers' job", () => {
    const i = buildBlockerIndex(board());
    expect(blockerTickets({ id: 'x', blockedBy: [] }, i)).toEqual([]);
  });
});
