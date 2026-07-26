import { describe, it, expect, vi } from 'vitest';
import { makeTokenProvider, type LoginResult } from './auth.js';

const at = (ms: number): LoginResult => ({ idToken: 't' + ms, refreshToken: 'r' + ms, expiresAtMs: ms });

describe('makeTokenProvider', () => {
  it('logs in once and caches the token', async () => {
    const login = vi.fn(async () => at(10_000_000));
    const refresh = vi.fn(async () => at(20_000_000));
    const tp = makeTokenProvider({ login, refresh, now: () => 0 });
    expect(await tp.getIdToken()).toBe('t10000000');
    expect(await tp.getIdToken()).toBe('t10000000');
    expect(login).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('refreshes when within 60s of expiry', async () => {
    let clock = 0;
    const login = vi.fn(async () => at(200_000)); // expires at 200s
    const refresh = vi.fn(async () => ({ idToken: 't2', refreshToken: 'r2', expiresAtMs: 500_000 }));
    const tp = makeTokenProvider({ login, refresh, now: () => clock });
    expect(await tp.getIdToken()).toBe('t200000');
    clock = 50_000; // 150s to expiry, >60s skew → cached
    expect(await tp.getIdToken()).toBe('t200000');
    expect(refresh).not.toHaveBeenCalled();
    clock = 150_000; // 50s to expiry, <60s skew → refresh
    expect(await tp.getIdToken()).toBe('t2');
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(login).toHaveBeenCalledTimes(1);
  });

  it('falls back to a fresh login if refresh fails', async () => {
    let clock = 0;
    const login = vi.fn(async () => at(100_000));
    const refresh = vi.fn(async () => {
      throw new Error('refresh expired');
    });
    const tp = makeTokenProvider({ login, refresh, now: () => clock });
    await tp.getIdToken();
    clock = 90_000;
    expect(await tp.getIdToken()).toBe('t100000'); // login re-run returns same fake; asserts no throw
    expect(login).toHaveBeenCalledTimes(2);
  });

  it('invalidate() forces a fresh login on the next getIdToken', async () => {
    const login = vi.fn(async () => at(10_000_000));
    const tp = makeTokenProvider({ login, refresh: vi.fn(), now: () => 0 });
    await tp.getIdToken();
    expect(login).toHaveBeenCalledTimes(1);
    tp.invalidate?.();
    await tp.getIdToken();
    expect(login).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent callers into one login', async () => {
    let resolve!: (v: LoginResult) => void;
    const login = vi.fn(() => new Promise<LoginResult>((r) => { resolve = r; }));
    const tp = makeTokenProvider({ login, refresh: vi.fn(), now: () => 0 });
    const a = tp.getIdToken();
    const b = tp.getIdToken();
    resolve(at(10_000_000));
    expect(await a).toBe('t10000000');
    expect(await b).toBe('t10000000');
    expect(login).toHaveBeenCalledTimes(1);
  });
});
