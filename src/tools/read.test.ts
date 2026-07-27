import { describe, it, expect, vi } from 'vitest';
import { resolveBoardId, selectBoardFields } from './read.js';

describe('resolveBoardId', () => {
  it('passes a raw board id through unchanged', async () => {
    const gql = vi.fn();
    expect(await resolveBoardId(gql as never, 'b-uuid-123')).toBe('b-uuid-123');
    expect(gql).not.toHaveBeenCalled();
  });

  it('resolves a board KEY to its id via myBoards', async () => {
    const gql = vi.fn(async () => ({ myBoards: [{ id: 'b1', key: 'TSK' }, { id: 'b2', key: 'PRD' }] }));
    expect(await resolveBoardId(gql as never, 'PRD')).toBe('b2');
  });

  it('throws when the key is unknown', async () => {
    const gql = vi.fn(async () => ({ myBoards: [{ id: 'b1', key: 'TSK' }] }));
    await expect(resolveBoardId(gql as never, 'ZZZ')).rejects.toThrow(/no board/i);
  });
});

describe('selectBoardFields', () => {
  const full = {
    board: { id: 'b1' },
    items: [{ ticket: 'TSK-1' }],
    tags: [{ id: 't1' }],
    releases: [{ id: 'r1' }],
    members: [{ userSub: 'u1' }],
  };

  it('returns every section when no fields are given', () => {
    expect(selectBoardFields(full)).toEqual(full);
  });

  it('returns only the requested sections', () => {
    expect(selectBoardFields(full, ['board', 'members'])).toEqual({
      board: { id: 'b1' },
      members: [{ userSub: 'u1' }],
    });
  });

  it('treats an empty list as every section, never as nothing', () => {
    expect(selectBoardFields(full, [])).toEqual(full);
  });
});
