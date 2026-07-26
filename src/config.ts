import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export interface PublicConfig {
  region: string;
  userPoolId: string;
  userPoolClientId: string;
  graphqlUrl: string;
}

/**
 * Load the committed public config (region/pool/client/graphql URL).
 * Looks next to the running file first (bundled layout: the installer copies
 * kando.config.json beside server.mjs), then the package root (dev/test: src/..).
 */
export function loadPublicConfig(): PublicConfig {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const p of [join(here, 'kando.config.json'), join(here, '..', 'kando.config.json')]) {
    try {
      return JSON.parse(readFileSync(p, 'utf8')) as PublicConfig;
    } catch {
      /* try next candidate */
    }
  }
  throw new Error('kando.config.json not found next to the server');
}

/** Parse a dotenv-style file: KEY=VALUE lines, `#` comments, no interpolation. */
function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

export function loadCredentials(credsPath: string): { email: string; password: string } {
  const env = parseDotenv(readFileSync(credsPath, 'utf8'));
  const email = env.KANDO_BOT_EMAIL;
  const password = env.KANDO_BOT_PASSWORD;
  if (!email) throw new Error('Missing KANDO_BOT_EMAIL in ' + credsPath);
  if (!password) throw new Error('Missing KANDO_BOT_PASSWORD in ' + credsPath);
  return { email, password };
}
