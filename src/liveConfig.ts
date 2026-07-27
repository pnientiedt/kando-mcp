import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { PublicConfig } from './config.js';

// The one hosted PROD Cognito pool. The live e2e must never run against it by
// accident: Dev and Prod configs differ only by ids, so a mistaken value would
// silently pass while creating throwaway boards in production (KDO-63).
export const PROD_POOL_ID = 'eu-central-1_djhXXORIL';

/** The four variables that name a stage. All of them, or none — see resolveLiveConfig. */
export const CONFIG_VARS = [
  'KANDO_TEST_REGION',
  'KANDO_TEST_POOL_ID',
  'KANDO_TEST_CLIENT_ID',
  'KANDO_TEST_GRAPHQL_URL',
] as const;

const packageRoot = () => join(dirname(fileURLToPath(import.meta.url)), '..');

/** The committed Dev stage config — public ids, the same class as kando.config.json. */
export function loadDevConfig(): PublicConfig {
  const p = join(packageRoot(), 'kando.config.dev.json');
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as PublicConfig;
  } catch {
    throw new Error(`live e2e: could not read ${p} — the Dev stage config is missing`);
  }
}

/** Parse KEY=VALUE lines. Blank lines and #comments are skipped; one layer of quotes is stripped. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const raw = trimmed.slice(eq + 1).trim();
    out[key] = /^(".*"|'.*')$/s.test(raw) ? raw.slice(1, -1) : raw;
  }
  return out;
}

const readEnvFile = (): Record<string, string> => {
  try {
    return parseEnvFile(readFileSync(join(packageRoot(), '.env.test.local'), 'utf8'));
  } catch {
    return {}; // absent is fine — the variables can come from the real environment
  }
};

/**
 * The environment the live test resolves against: gitignored .env.test.local,
 * with the real environment taking precedence (the dotenv convention), so CI can
 * supply the same names as secrets without touching a file.
 */
export function liveEnv(
  env: NodeJS.ProcessEnv = process.env,
  fromFile: () => Record<string, string> = readEnvFile,
): NodeJS.ProcessEnv {
  return { ...fromFile(), ...env };
}

/**
 * Build the MCP live-test target (config + credentials).
 *
 * The stage defaults to **Dev** (`kando.config.dev.json`); setting all four
 * KANDO_TEST_* target variables points it somewhere else. Credentials are never
 * defaulted and never committed. Guards LOUDLY against Prod: refuses the Prod
 * pool — however it was supplied — unless KANDO_ALLOW_PROD=1 is set explicitly.
 */
export function resolveLiveConfig(
  env: NodeJS.ProcessEnv = liveEnv(),
  readDevConfig: () => PublicConfig = loadDevConfig,
): { config: PublicConfig; creds: { email: string; password: string } } {
  const need = (k: string): string => {
    const v = env[k];
    if (!v) throw new Error(`live e2e: missing ${k}`);
    return v;
  };

  const provided = CONFIG_VARS.filter((k) => env[k]);
  let config: PublicConfig;
  if (provided.length === 0) {
    config = readDevConfig();
  } else if (provided.length === CONFIG_VARS.length) {
    config = {
      region: need('KANDO_TEST_REGION'),
      userPoolId: need('KANDO_TEST_POOL_ID'),
      userPoolClientId: need('KANDO_TEST_CLIENT_ID'),
      graphqlUrl: need('KANDO_TEST_GRAPHQL_URL'),
    };
  } else {
    // A partial override mixes two stages: sign in to one pool, write through the
    // other's API. Refuse rather than guess which half was meant.
    const missing = CONFIG_VARS.filter((k) => !env[k]);
    throw new Error(
      `live e2e: half-configured target — missing ${missing.join(', ')}. ` +
        `Set all of them or none (none targets the Dev stage from kando.config.dev.json).`,
    );
  }

  if (config.userPoolId === PROD_POOL_ID && env.KANDO_ALLOW_PROD !== '1') {
    throw new Error(
      `live e2e refuses to run against the PROD pool (${PROD_POOL_ID}). ` +
        'Point KANDO_TEST_* at a non-production stage, or set KANDO_ALLOW_PROD=1 to override.',
    );
  }

  return { config, creds: { email: need('KANDO_TEST_EMAIL'), password: need('KANDO_TEST_PASSWORD') } };
}
