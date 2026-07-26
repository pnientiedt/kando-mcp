// The MCP stores only a refresh token; Cognito refresh tokens are opaque, so
// expiry is computed as savedAt + the known validity window (mirrors the
// backend UserPoolClient's refreshTokenValidity).
export const REFRESH_TOKEN_VALIDITY_DAYS = 90;
export const WARN_WITHIN_DAYS = 5;
const DAY = 86_400_000;

export function expiryStatus(
  savedAt: string | null,
  now: number = Date.now(),
): { daysLeft: number; warn: boolean; expiresAt: Date } | null {
  if (!savedAt) return null;
  const savedMs = Date.parse(savedAt);
  if (Number.isNaN(savedMs)) return null;
  const expiresMs = savedMs + REFRESH_TOKEN_VALIDITY_DAYS * DAY;
  const daysLeft = Math.floor((expiresMs - now) / DAY);
  return { daysLeft, warn: daysLeft < WARN_WITHIN_DAYS, expiresAt: new Date(expiresMs) };
}

export function expiryMessage(daysLeft: number): string {
  const n = Math.max(0, daysLeft);
  return `⚠️ Kando session expires in ${n} day${n === 1 ? '' : 's'} — run \`kando-mcp login\` to refresh it.`;
}
