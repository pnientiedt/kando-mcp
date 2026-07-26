import { deleteStoredCreds } from '../credStore.js';

/**
 * Remove the locally stored refresh token. (Cognito global sign-out to revoke
 * it server-side is optional and best-effort; a stolen token is already
 * app-scoped and expires with the 90-day window.)
 */
export function runLogout(deps: { del: () => void; out: (s: string) => void }): void {
  deps.del();
  deps.out('✓ Logged out — local Kando token removed.');
}

export function logout(): void {
  runLogout({ del: () => deleteStoredCreds(), out: (s) => console.log(s) });
}
