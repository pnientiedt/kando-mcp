import type { PublicConfig } from './config.js';
import { srpTokenProvider, storedTokenProvider, type TokenProvider } from './auth.js';
import { loadStoredCreds, type StoredCreds } from './credStore.js';

/**
 * Resolve how the server authenticates, in priority order:
 *   1. KANDO_REFRESH_TOKEN env (CI / power users) — refresh-only.
 *   2. KANDO_EMAIL + KANDO_PASSWORD env — full SRP login.
 *   3. Stored credentials from `kando-mcp login`.
 *   4. Otherwise throw with an actionable message.
 * `savedAt` is non-null ONLY for the stored path — the env paths have no
 * anchor date, so the expiry warning is skipped for them.
 */
export function resolveAuth(
  config: PublicConfig,
  deps: { env?: NodeJS.ProcessEnv; load?: () => StoredCreds | null } = {},
): { provider: TokenProvider; email: string; savedAt: string | null } {
  const env = deps.env ?? process.env;
  const load = deps.load ?? (() => loadStoredCreds());

  if (env.KANDO_REFRESH_TOKEN) {
    return { provider: storedTokenProvider(config, env.KANDO_REFRESH_TOKEN), email: '', savedAt: null };
  }
  if (env.KANDO_EMAIL && env.KANDO_PASSWORD) {
    return {
      provider: srpTokenProvider(config, { email: env.KANDO_EMAIL, password: env.KANDO_PASSWORD }),
      email: env.KANDO_EMAIL,
      savedAt: null,
    };
  }
  const stored = load();
  if (stored) {
    return { provider: storedTokenProvider(config, stored.refreshToken), email: stored.email, savedAt: stored.savedAt };
  }
  throw new Error('No Kando credentials — run `kando-mcp login`.');
}
