import { describe, it, expect, vi } from 'vitest';
import { runLogin } from './login.js';

const config = {
  region: 'eu-central-1',
  userPoolId: 'eu-central-1_djhXXORIL',
  userPoolClientId: '1p5gi7ptukhnvr17itpf34bmuh',
  graphqlUrl: 'https://example.invalid/graphql',
};

describe('runLogin', () => {
  it('explains itself, stores the token, and reports expiry + next step', async () => {
    const save = vi.fn();
    const out: string[] = [];
    const labels: string[] = [];
    await runLogin({
      config,
      prompt: async (q: string, hidden?: boolean) => {
        labels.push(`${hidden ? 'hidden:' : 'visible:'}${q}`);
        return q.toLowerCase().includes('email') ? 'a@b.c' : 'pw';
      },
      loginOnce: async () => ({ idToken: 'ID', refreshToken: 'RT', expiresAtMs: 0 }),
      save,
      now: () => Date.parse('2026-07-26T00:00:00.000Z'),
      out: (s: string) => out.push(s),
    });
    const text = out.join('\n');
    // Intro gives context on WHY an email is asked and where Kando lives.
    expect(text).toMatch(/kando\.pnientiedt\.de/);
    // The email prompt is labelled clearly; the password prompt is hidden.
    expect(labels.some((l) => /visible:.*email/i.test(l))).toBe(true);
    expect(labels.some((l) => /^hidden:Password/.test(l))).toBe(true);
    // Stores the refresh token + savedAt.
    expect(save).toHaveBeenCalledWith({
      email: 'a@b.c',
      refreshToken: 'RT',
      savedAt: '2026-07-26T00:00:00.000Z',
    });
    // Reports outcome + expiry (90 days after 2026-07-26 = 2026-10-24) + next step.
    expect(text).toMatch(/Logged in as a@b\.c/);
    expect(text).toMatch(/valid until/i);
    expect(text).toMatch(/2026-10-24/);
    expect(text).toMatch(/kando-mcp init/);
  });

  it('aborts with a clear error when no email is entered', async () => {
    await expect(
      runLogin({
        config,
        prompt: async () => '   ', // always blank
        loginOnce: async () => ({ idToken: 'ID', refreshToken: 'RT', expiresAtMs: 0 }),
        save: () => {},
        now: () => 0,
        out: () => {},
      }),
    ).rejects.toThrow(/email/i);
  });
});
