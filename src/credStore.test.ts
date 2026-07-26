import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  configDir,
  saveCreds,
  loadStoredCreds,
  deleteStoredCreds,
} from './credStore.js';

describe('configDir', () => {
  it('uses XDG_CONFIG_HOME on linux when set', () => {
    expect(configDir({ XDG_CONFIG_HOME: '/x' }, 'linux')).toBe('/x/kando');
  });
  it('falls back to ~/.config on linux', () => {
    expect(configDir({ HOME: '/home/u' }, 'linux')).toBe('/home/u/.config/kando');
  });
  it('uses Application Support on macOS', () => {
    expect(configDir({ HOME: '/Users/u' }, 'darwin')).toBe(
      '/Users/u/Library/Application Support/kando',
    );
  });
  it('uses APPDATA on windows', () => {
    expect(configDir({ APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, 'win32')).toBe(
      'C:\\Users\\u\\AppData\\Roaming\\kando',
    );
  });
});

describe('save/load/delete roundtrip', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kando-creds-'));
  const path = join(dir, 'credentials.json');
  afterEach(() => deleteStoredCreds({ path }));

  it('roundtrips and (posix) chmods 600', () => {
    const creds = { email: 'a@b.c', refreshToken: 'rt', savedAt: '2026-07-26T00:00:00.000Z' };
    saveCreds(creds, { path });
    expect(loadStoredCreds({ path })).toEqual(creds);
    if (process.platform !== 'win32') {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
    deleteStoredCreds({ path });
    expect(loadStoredCreds({ path })).toBeNull();
  });

  it('returns null for missing/garbage', () => {
    expect(loadStoredCreds({ path: join(dir, 'nope.json') })).toBeNull();
  });
});
