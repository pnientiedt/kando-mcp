import type { PublicConfig } from './config.js';

// The one hosted PROD Cognito pool. The live e2e must never run against it by
// accident: Dev and Prod configs differ only by ids, so a mistaken value would
// silently pass while creating throwaway boards in production (KDO-63).
export const PROD_POOL_ID = 'eu-central-1_djhXXORIL';

/**
 * Build the MCP live-test target (config + credentials) entirely from the
 * environment, so the test can point at the Dev stage — or any non-Prod
 * environment — without a committed config. Guards LOUDLY against Prod: refuses
 * the Prod pool unless KANDO_ALLOW_PROD=1 is set explicitly.
 */
export function resolveLiveConfig(env: NodeJS.ProcessEnv = process.env): {
  config: PublicConfig;
  creds: { email: string; password: string };
} {
  const need = (k: string): string => {
    const v = env[k];
    if (!v) throw new Error(`live e2e: missing ${k} (set the Dev stage's value)`);
    return v;
  };
  const config: PublicConfig = {
    region: need('KANDO_TEST_REGION'),
    userPoolId: need('KANDO_TEST_POOL_ID'),
    userPoolClientId: need('KANDO_TEST_CLIENT_ID'),
    graphqlUrl: need('KANDO_TEST_GRAPHQL_URL'),
  };
  if (config.userPoolId === PROD_POOL_ID && env.KANDO_ALLOW_PROD !== '1') {
    throw new Error(
      `live e2e refuses to run against the PROD pool (${PROD_POOL_ID}). ` +
        'Point KANDO_TEST_* at the Dev stage, or set KANDO_ALLOW_PROD=1 to override.',
    );
  }
  return { config, creds: { email: need('KANDO_TEST_EMAIL'), password: need('KANDO_TEST_PASSWORD') } };
}
