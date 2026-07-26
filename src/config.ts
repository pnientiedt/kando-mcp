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
