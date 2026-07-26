import { describe, it, expect } from 'vitest';
import { parsePosition, peerGroup, planReorder } from './reorder.js';
import { rankBetween } from './rank.js';

/**
 * A `getBoard` payload shaped exactly like the one `GET_BOARD` returns — the
 * planner reads `board.key`/`board.columns` and `stories[].subtasks[]` straight
 * out of the response the tool already fetched, so the fixtures are the real
 * wire shape (including `rank`, `num` and `archivedAt`).
 *
 * Layout:
 *   lane A (container, ranks over the whole board): KDO-1  rank 'b'
 *     subtasks: KDO-10 open 'b', KDO-11 open 'd', KDO-12 done 'c'
 *   lane B (container):                             KDO-2  rank 'd'
 *     subtasks: KDO-20 open 'b'
 *   standalone open:   KDO-30 'b', KDO-31 'd'
 *   standalone done:   KDO-40 'b'
 *   archived standalone open: KDO-99 'a'  (must never be a peer)
 */
function board(): any {
  return {
    board: {
      id: 'b1',
      key: 'KDO',
      columns: [
        { id: 'open', label: 'Open', order: 0 },
        { id: 'done', label: 'Done', order: 1 },
      ],
    },
    stories: [
      {
        id: 'A',
        num: 1,
        columnId: 'open',
        rank: 'b',
        archivedAt: null,
        subtasks: [
          { id: 'A10', num: 10, storyId: 'A', columnId: 'open', rank: 'b', archivedAt: null },
          { id: 'A11', num: 11, storyId: 'A', columnId: 'open', rank: 'd', archivedAt: null },
          { id: 'A12', num: 12, storyId: 'A', columnId: 'done', rank: 'c', archivedAt: null },
        ],
      },
      {
        id: 'B',
        num: 2,
        columnId: 'open',
        rank: 'd',
        archivedAt: null,
        subtasks: [{ id: 'B20', num: 20, storyId: 'B', columnId: 'open', rank: 'b', archivedAt: null }],
      },
      { id: 'S30', num: 30, columnId: 'open', rank: 'b', archivedAt: null, subtasks: [] },
      { id: 'S31', num: 31, columnId: 'open', rank: 'd', archivedAt: null, subtasks: [] },
      { id: 'S40', num: 40, columnId: 'done', rank: 'b', archivedAt: null, subtasks: [] },
      { id: 'S99', num: 99, columnId: 'open', rank: 'a', archivedAt: '2026-01-01T00:00:00Z', subtasks: [] },
    ],
  };
}

const ids = (xs: Array<{ id: string }>) => xs.map((x) => x.id);

describe('parsePosition', () => {
  it('accepts exactly one of to/before/after', () => {
    expect(parsePosition({ to: 'top' })).toEqual({ to: 'top' });
    expect(parsePosition({ to: 'bottom' })).toEqual({ to: 'bottom' });
    expect(parsePosition({ before: 'KDO-5' })).toEqual({ before: 'KDO-5' });
    expect(parsePosition({ after: 'KDO-5' })).toEqual({ after: 'KDO-5' });
  });

  it('rejects none, naming the rule', () => {
    expect(() => parsePosition({})).toThrow(/exactly one of.*to.*before.*after/i);
  });

  it('rejects more than one, naming the rule', () => {
    expect(() => parsePosition({ to: 'top', before: 'KDO-5' })).toThrow(
      /exactly one of.*to.*before.*after/i,
    );
    expect(() => parsePosition({ before: 'KDO-5', after: 'KDO-6' })).toThrow(/exactly one/i);
  });

  it('rejects an unknown `to` value', () => {
    expect(() => parsePosition({ to: 'middle' })).toThrow(/top.*bottom/i);
  });
});

describe('peerGroup', () => {
  it("a subtask's peers are its parent's non-archived subtasks in the SAME column", () => {
    const { peers, self } = peerGroup(board(), { boardId: 'b1', storyId: 'A', subtaskId: 'A10' });
    expect(self.id).toBe('A10');
    // A11 is the only other open subtask of A; A12 is in `done`; B20 belongs to another story.
    expect(ids(peers)).toEqual(['A11']);
  });

  it('a standalone story ranks among non-archived standalone stories in the same column', () => {
    const { peers } = peerGroup(board(), { boardId: 'b1', storyId: 'S30' });
    // S31 only: S40 is in `done`, S99 is archived, A and B are containers.
    expect(ids(peers)).toEqual(['S31']);
  });

  it('a container story ranks among container stories BOARD-WIDE (the lane order)', () => {
    const { peers } = peerGroup(board(), { boardId: 'b1', storyId: 'A' });
    expect(ids(peers)).toEqual(['B']);
  });

  it('never includes the moving ticket itself', () => {
    const { peers } = peerGroup(board(), { boardId: 'b1', storyId: 'A', subtaskId: 'A11' });
    expect(ids(peers)).toEqual(['A10']);
  });

  it('sorts peers by rank ascending', () => {
    const bc = board();
    bc.stories[0].subtasks.push({
      id: 'A13',
      num: 13,
      storyId: 'A',
      columnId: 'open',
      rank: 'a',
      archivedAt: null,
    });
    const { peers } = peerGroup(bc, { boardId: 'b1', storyId: 'A', subtaskId: 'A10' });
    expect(ids(peers)).toEqual(['A13', 'A11']);
  });
});

describe('planReorder', () => {
  it('top puts a subtask before its first peer', () => {
    const rank = planReorder(board(), { boardId: 'b1', storyId: 'A', subtaskId: 'A11' }, { to: 'top' });
    expect(rank).toBe(rankBetween(null, 'b'));
    expect(rank < 'b').toBe(true);
  });

  it('bottom puts a subtask after its last peer', () => {
    const rank = planReorder(
      board(),
      { boardId: 'b1', storyId: 'A', subtaskId: 'A10' },
      { to: 'bottom' },
    );
    expect(rank).toBe(rankBetween('d', null));
    expect(rank > 'd').toBe(true);
  });

  it('before a peer lands between that peer and the one above it', () => {
    // Move A10 (rank b) to just before A11 (rank d) — no peer above A11 once A10 is excluded.
    const rank = planReorder(
      board(),
      { boardId: 'b1', storyId: 'A', subtaskId: 'A10' },
      { before: 'KDO-11' },
    );
    expect(rank).toBe(rankBetween(null, 'd'));
    expect(rank < 'd').toBe(true);
  });

  it('after a peer lands between that peer and the one below it', () => {
    const rank = planReorder(
      board(),
      { boardId: 'b1', storyId: 'A', subtaskId: 'A11' },
      { after: 'KDO-10' },
    );
    expect(rank).toBe(rankBetween('b', null));
    expect(rank > 'b').toBe(true);
  });

  it('ranks a standalone story among the standalone stories in its column', () => {
    const rank = planReorder(board(), { boardId: 'b1', storyId: 'S31' }, { to: 'top' });
    expect(rank).toBe(rankBetween(null, 'b'));
  });

  it('ranks a container story among the lanes, board-wide', () => {
    // B's only peer lane is A (rank 'b'), regardless of column.
    const rank = planReorder(board(), { boardId: 'b1', storyId: 'B' }, { to: 'top' });
    expect(rank).toBe(rankBetween(null, 'b'));
  });

  it('a ticket alone in its peer group is not an error (any position works)', () => {
    const rank = planReorder(board(), { boardId: 'b1', storyId: 'S40' }, { to: 'top' });
    expect(typeof rank).toBe('string');
    expect(rank.length).toBeGreaterThan(0);
  });

  it('rejects before/after a ticket in a DIFFERENT peer group, actionably', () => {
    // A12 is a subtask of A but sits in `done`, while A10 sits in `open`.
    expect(() =>
      planReorder(board(), { boardId: 'b1', storyId: 'A', subtaskId: 'A10' }, { before: 'KDO-12' }),
    ).toThrow(/KDO-12.*different column.*move/i);
  });

  it('rejects before/after a ticket under a different parent story', () => {
    expect(() =>
      planReorder(board(), { boardId: 'b1', storyId: 'A', subtaskId: 'A10' }, { after: 'KDO-20' }),
    ).toThrow(/KDO-20/);
  });

  it('rejects positioning a ticket relative to itself', () => {
    expect(() =>
      planReorder(board(), { boardId: 'b1', storyId: 'A', subtaskId: 'A10' }, { before: 'KDO-10' }),
    ).toThrow(/itself/i);
  });

  it('does not blame the column when a LANE is asked to rank against a non-lane', () => {
    // Lanes rank board-wide, so "move it to this column first" would be bad advice:
    // S40 is a standalone story in `done`, A is a container lane in `open`.
    let message = '';
    try {
      planReorder(board(), { boardId: 'b1', storyId: 'A' }, { before: 'KDO-40' });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/KDO-40/);
    expect(message).not.toMatch(/different column/i);
    expect(message).toMatch(/lane/i);
  });

  it("names the TARGET's kind, not the moving ticket's, when they are different groups", () => {
    // A is a container lane; KDO-30 is a standalone story in the same column.
    expect(() => planReorder(board(), { boardId: 'b1', storyId: 'A' }, { before: 'KDO-30' })).toThrow(
      /KDO-30 is a standalone story/i,
    );
    // …and the mirror image: a standalone story pointed at a lane.
    expect(() => planReorder(board(), { boardId: 'b1', storyId: 'S30' }, { before: 'KDO-1' })).toThrow(
      /KDO-1 is a container story \(a lane\)/i,
    );
  });

  it('rejects a before/after target that is not on this board', () => {
    expect(() =>
      planReorder(board(), { boardId: 'b1', storyId: 'S30' }, { before: 'KDO-777' }),
    ).toThrow(/KDO-777/);
  });

  it('ignores archived peers entirely — they cannot even be a before/after target', () => {
    // S99 is an archived standalone story in the same column as S30/S31.
    expect(() =>
      planReorder(board(), { boardId: 'b1', storyId: 'S31' }, { before: 'KDO-99' }),
    ).toThrow(/KDO-99/);
  });
});
