import { describe, it, expect } from 'vitest';
import { resolveLiveConfig, PROD_POOL_ID } from './liveConfig.js';

const base = {
  KANDO_TEST_REGION: 'eu-central-1',
  KANDO_TEST_POOL_ID: 'eu-central-1_DevPoolXX',
  KANDO_TEST_CLIENT_ID: 'devclient',
  KANDO_TEST_GRAPHQL_URL: 'https://dev.example/graphql',
  KANDO_TEST_EMAIL: 'e2e@dev',
  KANDO_TEST_PASSWORD: 'pw',
};

describe('resolveLiveConfig', () => {
  it('builds config + creds from env', () => {
    const { config, creds } = resolveLiveConfig(base);
    expect(config.userPoolId).toBe('eu-central-1_DevPoolXX');
    expect(creds).toEqual({ email: 'e2e@dev', password: 'pw' });
  });

  it('throws naming a missing variable', () => {
    expect(() => resolveLiveConfig({ ...base, KANDO_TEST_POOL_ID: '' })).toThrow(/KANDO_TEST_POOL_ID/);
  });

  it('refuses the PROD pool by default (loud guard)', () => {
    expect(() => resolveLiveConfig({ ...base, KANDO_TEST_POOL_ID: PROD_POOL_ID })).toThrow(/PROD/);
  });

  it('allows PROD only with an explicit override', () => {
    const { config } = resolveLiveConfig({
      ...base,
      KANDO_TEST_POOL_ID: PROD_POOL_ID,
      KANDO_ALLOW_PROD: '1',
    });
    expect(config.userPoolId).toBe(PROD_POOL_ID);
  });
});
