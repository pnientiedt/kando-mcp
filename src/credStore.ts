import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  chmodSync,
} from 'node:fs';
import { dirname, join, posix as posixPath, win32 as win32Path } from 'node:path';

export type StoredCreds = { email: string; refreshToken: string; savedAt: string };

/**
 * The per-user config directory for stored credentials, chosen per OS:
 *   - Windows: %APPDATA%\kando (falls back to %USERPROFILE%\AppData\Roaming)
 *   - macOS:   ~/Library/Application Support/kando
 *   - Linux:   $XDG_CONFIG_HOME/kando, else ~/.config/kando
 * Args are injected for testing; defaults read the live environment/platform.
 */
export function configDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  // Use the TARGET platform's path semantics, not the host's, so the directory
  // is correct even when a Windows path is computed on a POSIX host (and tests).
  if (platform === 'win32') {
    const p = win32Path;
    return p.join(env.APPDATA ?? p.join(env.USERPROFILE ?? '.', 'AppData', 'Roaming'), 'kando');
  }
  const p = posixPath;
  if (platform === 'darwin') {
    return p.join(env.HOME ?? '.', 'Library', 'Application Support', 'kando');
  }
  return p.join(env.XDG_CONFIG_HOME ?? p.join(env.HOME ?? '.', '.config'), 'kando');
}

export function credentialsPath(env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): string {
  return join(configDir(env, platform), 'credentials.json');
}

function pathOf(opts?: { path?: string }): string {
  return opts?.path ?? credentialsPath();
}

export function saveCreds(creds: StoredCreds, opts?: { path?: string }): void {
  const p = pathOf(opts);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(creds, null, 2) + '\n');
  // The refresh token is a bearer credential — keep it owner-only on POSIX.
  // On Windows the %APPDATA% directory is already user-ACL-scoped.
  if (process.platform !== 'win32') chmodSync(p, 0o600);
}

export function loadStoredCreds(opts?: { path?: string }): StoredCreds | null {
  const p = pathOf(opts);
  if (!existsSync(p)) return null;
  try {
    const o = JSON.parse(readFileSync(p, 'utf8'));
    if (
      o &&
      typeof o.email === 'string' &&
      typeof o.refreshToken === 'string' &&
      typeof o.savedAt === 'string'
    ) {
      return o as StoredCreds;
    }
    return null;
  } catch {
    return null;
  }
}

export function deleteStoredCreds(opts?: { path?: string }): void {
  const p = pathOf(opts);
  if (existsSync(p)) rmSync(p);
}
