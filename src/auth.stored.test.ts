import { describe, it, expect, vi } from 'vitest';
import { makeStoredTokenProvider } from './auth.js';

describe('makeStoredTokenProvider', () => {
  it('returns an id token via refresh', async () => {
    const refresh = vi.fn(async () => ({
      idToken: 'ID',
      refreshToken: 'rt2',
      expiresAtMs: Date.now() + 3_600_000,
    }));
    const p = makeStoredTokenProvider('rt', refresh);
    expect(await p.getIdToken()).toBe('ID');
    expect(refresh).toHaveBeenCalledWith('rt');
  });

  it('surfaces an actionable error when refresh fails', async () => {
    const refresh = vi.fn(async () => {
      throw new Error('NotAuthorized');
    });
    const p = makeStoredTokenProvider('rt', refresh);
    await expect(p.getIdToken()).rejects.toThrow(/run .*kando-mcp login/);
  });
});
