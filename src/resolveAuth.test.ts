import { describe, it, expect } from 'vitest';
import { resolveAuth } from './resolveAuth.js';

// Real public pool/client ids: CognitoUserPool validates the id format at
// construction (offline). The tests never call getIdToken, so no network.
const config = {
  region: 'eu-central-1',
  userPoolId: 'eu-central-1_djhXXORIL',
  userPoolClientId: '1p5gi7ptukhnvr17itpf34bmuh',
  graphqlUrl: 'https://example.invalid/graphql',
};

describe('resolveAuth', () => {
  it('prefers KANDO_REFRESH_TOKEN', () => {
    const r = resolveAuth(config, { env: { KANDO_REFRESH_TOKEN: 'rt' }, load: () => null });
    expect(r.email).toBe('');
    expect(r.savedAt).toBeNull();
    expect(r.provider.getIdToken).toBeTypeOf('function');
  });

  it('uses email+password env next', () => {
    const r = resolveAuth(config, {
      env: { KANDO_EMAIL: 'a@b.c', KANDO_PASSWORD: 'pw' },
      load: () => null,
    });
    expect(r.email).toBe('a@b.c');
    expect(r.savedAt).toBeNull();
  });

  it('falls back to stored creds', () => {
    const r = resolveAuth(config, {
      env: {},
      load: () => ({ email: 's@b.c', refreshToken: 'rt', savedAt: '2026-07-26T00:00:00.000Z' }),
    });
    expect(r.email).toBe('s@b.c');
    expect(r.savedAt).toBe('2026-07-26T00:00:00.000Z');
  });

  it('throws when nothing is configured', () => {
    expect(() => resolveAuth(config, { env: {}, load: () => null })).toThrow(/kando-mcp login/);
  });
});
