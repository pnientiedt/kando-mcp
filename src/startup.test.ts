import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadRuntime } from './startup.js';

describe('loadRuntime', () => {
  it('loads config + credentials when both are valid', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kando-'));
    const p = join(dir, 'credentials');
    writeFileSync(p, 'KANDO_BOT_EMAIL=bot@example.com\nKANDO_BOT_PASSWORD=secret\n');
    const rt = loadRuntime(p);
    expect(rt.creds.email).toBe('bot@example.com');
    expect(rt.config.userPoolId).toBe('eu-central-1_djhXXORIL');
  });

  it('throws a diagnostic when the credentials file is missing', () => {
    expect(() => loadRuntime('/no/such/kando/credentials')).toThrow();
  });

  it('throws naming the missing key when a credential is absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kando-'));
    const p = join(dir, 'credentials');
    writeFileSync(p, 'KANDO_BOT_EMAIL=only@example.com\n');
    expect(() => loadRuntime(p)).toThrow(/KANDO_BOT_PASSWORD/);
  });
});
