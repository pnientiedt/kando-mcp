import { describe, it, expect } from 'vitest';
import {
  resolveLiveConfig,
  loadDevConfig,
  parseEnvFile,
  liveEnv,
  CONFIG_VARS,
  PROD_POOL_ID,
} from './liveConfig.js';
import type { PublicConfig } from './config.js';

const credsOnly = { KANDO_TEST_EMAIL: 'e2e@dev', KANDO_TEST_PASSWORD: 'pw' };
const base = {
  KANDO_TEST_REGION: 'eu-central-1',
  KANDO_TEST_POOL_ID: 'eu-central-1_DevPoolXX',
  KANDO_TEST_CLIENT_ID: 'devclient',
  KANDO_TEST_GRAPHQL_URL: 'https://dev.example/graphql',
  ...credsOnly,
};

const fakeDev: PublicConfig = {
  region: 'eu-central-1',
  userPoolId: 'eu-central-1_FromFile',
  userPoolClientId: 'fileclient',
  graphqlUrl: 'https://file.example/graphql',
};
const readFake = () => fakeDev;

describe('resolveLiveConfig', () => {
  it('defaults to the committed Dev config when no target vars are set', () => {
    const { config, creds } = resolveLiveConfig(credsOnly, readFake);
    expect(config).toEqual(fakeDev);
    expect(creds).toEqual({ email: 'e2e@dev', password: 'pw' });
  });

  it('lets a full set of KANDO_TEST_* vars override the Dev default', () => {
    const { config } = resolveLiveConfig(base, readFake);
    expect(config.userPoolId).toBe('eu-central-1_DevPoolXX');
    expect(config.graphqlUrl).toBe('https://dev.example/graphql');
  });

  // A partial override could mix two stages — sign in to one, write to the other.
  it('refuses a half-configured target, naming what is missing', () => {
    const half = { ...credsOnly, KANDO_TEST_POOL_ID: 'eu-central-1_Other' };
    expect(() => resolveLiveConfig(half, readFake)).toThrow(/KANDO_TEST_REGION/);
    expect(() => resolveLiveConfig(half, readFake)).toThrow(/all of them or none/i);
  });

  it('requires credentials even when the config comes from the file', () => {
    expect(() => resolveLiveConfig({ KANDO_TEST_EMAIL: 'e2e@dev' }, readFake)).toThrow(
      /KANDO_TEST_PASSWORD/,
    );
  });

  it('refuses the PROD pool by default (loud guard)', () => {
    expect(() => resolveLiveConfig({ ...base, KANDO_TEST_POOL_ID: PROD_POOL_ID }, readFake)).toThrow(
      /PROD/,
    );
  });

  it('guards the file-supplied config too, not just env overrides', () => {
    const prodFromFile = () => ({ ...fakeDev, userPoolId: PROD_POOL_ID });
    expect(() => resolveLiveConfig(credsOnly, prodFromFile)).toThrow(/PROD/);
  });

  it('allows PROD only with an explicit override', () => {
    const { config } = resolveLiveConfig(
      { ...base, KANDO_TEST_POOL_ID: PROD_POOL_ID, KANDO_ALLOW_PROD: '1' },
      readFake,
    );
    expect(config.userPoolId).toBe(PROD_POOL_ID);
  });
});

describe('loadDevConfig', () => {
  it('reads the committed Dev config and it is not Prod', () => {
    const config = loadDevConfig();
    expect(config.userPoolId).not.toBe(PROD_POOL_ID);
    expect(config.userPoolId).toMatch(/^eu-central-1_/);
    expect(config.graphqlUrl).toContain('appsync-api');
  });
});

describe('parseEnvFile', () => {
  it('reads KEY=VALUE, skipping blanks and comments', () => {
    expect(parseEnvFile('# note\n\nA=1\nB = two \n')).toEqual({ A: '1', B: 'two' });
  });

  it('strips one layer of surrounding quotes and keeps = inside values', () => {
    expect(parseEnvFile('A="p=ss"\nB=\'x\'')).toEqual({ A: 'p=ss', B: 'x' });
  });
});

describe('liveEnv', () => {
  it('lets the real environment win over the file, as dotenv does', () => {
    const merged = liveEnv({ KANDO_TEST_EMAIL: 'real@dev' }, () => ({
      KANDO_TEST_EMAIL: 'file@dev',
      KANDO_TEST_PASSWORD: 'filepw',
    }));
    expect(merged.KANDO_TEST_EMAIL).toBe('real@dev');
    expect(merged.KANDO_TEST_PASSWORD).toBe('filepw');
  });
});

describe('CONFIG_VARS', () => {
  it('names the four target variables', () => {
    expect([...CONFIG_VARS]).toEqual([
      'KANDO_TEST_REGION',
      'KANDO_TEST_POOL_ID',
      'KANDO_TEST_CLIENT_ID',
      'KANDO_TEST_GRAPHQL_URL',
    ]);
  });
});
