import { describe, it, expect, vi } from 'vitest';
import { resolveBoardId } from './read.js';

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
