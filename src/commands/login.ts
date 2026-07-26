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
  deps.out('Log in to Kando');
  deps.out('Kando is hosted at https://kando.pnientiedt.de — sign in with your Kando');
  deps.out('account (the same email + password you use at the site). No account yet?');
  deps.out('Sign up there first, then run this again.');
  deps.out('');

  let email = '';
  for (let attempt = 0; attempt < 3 && !email; attempt++) {
    email = (await deps.prompt('Kando account email: ')).trim();
    if (!email) deps.out('An email is required — it identifies your Kando account.');
  }
  if (!email) throw new Error('No email entered — aborting login.');

  const password = await deps.prompt('Password (hidden): ', true);
  if (!password) throw new Error('No password entered — aborting login.');

  const res = await deps.loginOnce(deps.config, { email, password });
  const savedAt = new Date(deps.now()).toISOString();
  deps.save({ email, refreshToken: res.refreshToken, savedAt });
  const expires = new Date(deps.now() + REFRESH_TOKEN_VALIDITY_DAYS * 86_400_000);
  deps.out('');
  deps.out(
    `✓ Logged in as ${email}. Session valid until ${expires.toISOString().slice(0, 10)} (${REFRESH_TOKEN_VALIDITY_DAYS} days).`,
  );
  deps.out('  Next: run `npx kando-mcp init` inside a repo to start using Kando there.');
}

export async function login(): Promise<void> {
  if (!process.stdin.isTTY) {
    throw new Error(
      'kando-mcp login needs an interactive terminal. For non-interactive use (CI, ' +
        'scripts), set KANDO_EMAIL and KANDO_PASSWORD — or KANDO_REFRESH_TOKEN — instead.',
    );
  }
  await runLogin({
    config: loadPublicConfig(),
    prompt: (q, hidden) => (hidden ? promptHidden(q) : promptLine(q)),
    loginOnce: srpLoginOnce,
    save: saveCreds,
    now: Date.now,
    out: (s) => console.log(s),
  });
}
