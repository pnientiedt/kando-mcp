import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadPublicConfig, loadCredentials } from './config.js';

describe('config', () => {
  it('loads the committed public config', () => {
    const c = loadPublicConfig();
    expect(c.userPoolId).toBe('eu-central-1_djhXXORIL');
    expect(c.graphqlUrl).toContain('appsync-api');
  });

  it('parses a dotenv credentials file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kando-'));
    const p = join(dir, 'credentials');
    writeFileSync(p, 'KANDO_BOT_EMAIL=bot@example.com\nKANDO_BOT_PASSWORD=p@ss=word\n# comment\n');
    const creds = loadCredentials(p);
    expect(creds.email).toBe('bot@example.com');
    expect(creds.password).toBe('p@ss=word');
  });

  it('throws a clear error when a key is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kando-'));
    const p = join(dir, 'credentials');
    writeFileSync(p, 'KANDO_BOT_EMAIL=only@example.com\n');
    expect(() => loadCredentials(p)).toThrow(/KANDO_BOT_PASSWORD/);
  });
});
