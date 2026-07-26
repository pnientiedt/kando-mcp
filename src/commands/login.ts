import { loadPublicConfig, type PublicConfig } from '../config.js';
import { srpLoginOnce, type LoginResult } from '../auth.js';
import { saveCreds } from '../credStore.js';
import { REFRESH_TOKEN_VALIDITY_DAYS } from '../expiry.js';
import { promptLine, promptHidden } from '../prompt.js';

/**
 * Interactive login: prompt for email + password, authenticate once via SRP,
 * and persist ONLY the refresh token (+ email + savedAt). Reports the computed
 * expiry date. All IO is injected so the logic is unit-testable.
 */
export async function runLogin(deps: {
  config: PublicConfig;
  prompt: (q: string, hidden?: boolean) => Promise<string>;
  loginOnce: (config: PublicConfig, creds: { email: string; password: string }) => Promise<LoginResult>;
  save: (c: { email: string; refreshToken: string; savedAt: string }) => void;
  now: () => number;
  out: (s: string) => void;
}): Promise<void> {
  const email = (await deps.prompt('Email: ')).trim();
  const password = await deps.prompt('Password: ', true);
  const res = await deps.loginOnce(deps.config, { email, password });
  const savedAt = new Date(deps.now()).toISOString();
  deps.save({ email, refreshToken: res.refreshToken, savedAt });
  const expires = new Date(deps.now() + REFRESH_TOKEN_VALIDITY_DAYS * 86_400_000);
  deps.out(`✓ Logged in as ${email} — valid until ${expires.toISOString().slice(0, 10)}.`);
}

export async function login(): Promise<void> {
  await runLogin({
    config: loadPublicConfig(),
    prompt: (q, hidden) => (hidden ? promptHidden(q) : promptLine(q)),
    loginOnce: srpLoginOnce,
    save: saveCreds,
    now: Date.now,
    out: (s) => console.log(s),
  });
}
