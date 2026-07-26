import {
  CognitoUserPool,
  CognitoUser,
  AuthenticationDetails,
  CognitoRefreshToken,
} from 'amazon-cognito-identity-js';
import type { PublicConfig } from './config.js';

export type LoginResult = { idToken: string; refreshToken: string; expiresAtMs: number };
export interface TokenProvider {
  getIdToken(): Promise<string>;
  /** Drop the cached token so the next getIdToken re-authenticates (used after a 401). */
  invalidate?(): void;
}

const SKEW_MS = 60_000; // refresh this long before expiry

export function makeTokenProvider(deps: {
  login: () => Promise<LoginResult>;
  refresh: (refreshToken: string) => Promise<LoginResult>;
  now?: () => number;
}): TokenProvider {
  const now = deps.now ?? Date.now;
  let cached: LoginResult | null = null;
  let inflight: Promise<LoginResult> | null = null;

  async function fresh(): Promise<LoginResult> {
    if (inflight) return inflight;
    inflight = deps.login().finally(() => {
      inflight = null;
    });
    cached = await inflight;
    return cached;
  }

  return {
    async getIdToken() {
      if (!cached) return (await fresh()).idToken;
      if (now() < cached.expiresAtMs - SKEW_MS) return cached.idToken;
      try {
        cached = await deps.refresh(cached.refreshToken);
      } catch {
        cached = await fresh();
      }
      return cached.idToken;
    },
    invalidate() {
      cached = null;
    },
  };
}

/**
 * One-shot SRP authentication returning the tokens. Used by both
 * `srpTokenProvider` (server, email+password env) and the `login` command
 * (which persists only the returned refresh token).
 */
export function srpLoginOnce(
  config: PublicConfig,
  creds: { email: string; password: string },
): Promise<LoginResult> {
  const pool = new CognitoUserPool({
    UserPoolId: config.userPoolId,
    ClientId: config.userPoolClientId,
  });
  const user = new CognitoUser({ Username: creds.email, Pool: pool });
  return new Promise<LoginResult>((resolve, reject) => {
    user.authenticateUser(
      new AuthenticationDetails({ Username: creds.email, Password: creds.password }),
      {
        onSuccess: (s) =>
          resolve({
            idToken: s.getIdToken().getJwtToken(),
            refreshToken: s.getRefreshToken().getToken(),
            expiresAtMs: s.getIdToken().getExpiration() * 1000,
          }),
        onFailure: (err) => reject(err),
      },
    );
  });
}

export function srpTokenProvider(
  config: PublicConfig,
  creds: { email: string; password: string },
): TokenProvider {
  const pool = new CognitoUserPool({
    UserPoolId: config.userPoolId,
    ClientId: config.userPoolClientId,
  });
  const user = () => new CognitoUser({ Username: creds.email, Pool: pool });

  const login = () => srpLoginOnce(config, creds);

  const refresh = (refreshToken: string) =>
    new Promise<LoginResult>((resolve, reject) => {
      user().refreshSession(new CognitoRefreshToken({ RefreshToken: refreshToken }), (err, s) => {
        if (err || !s) return reject(err ?? new Error('no session'));
        resolve({
          idToken: s.getIdToken().getJwtToken(),
          refreshToken: s.getRefreshToken().getToken(),
          expiresAtMs: s.getIdToken().getExpiration() * 1000,
        });
      });
    });

  return makeTokenProvider({ login, refresh });
}

const SESSION_EXPIRED = 'Kando session expired — run `kando-mcp login` again.';

/**
 * A refresh-only TokenProvider seeded from a stored refresh token. No password
 * fallback: an expired/revoked token surfaces an actionable error telling the
 * user to log in again, rather than hanging. `refresh` is injected for testing;
 * `storedTokenProvider` wires the real Cognito refresh.
 */
export function makeStoredTokenProvider(
  refreshToken: string,
  refresh: (rt: string) => Promise<LoginResult>,
): TokenProvider {
  let cached: LoginResult | null = null;
  return {
    async getIdToken() {
      try {
        if (!cached || Date.now() >= cached.expiresAtMs - SKEW_MS) {
          cached = await refresh(cached?.refreshToken ?? refreshToken);
        }
        return cached.idToken;
      } catch {
        throw new Error(SESSION_EXPIRED);
      }
    },
    invalidate() {
      cached = null;
    },
  };
}

export function storedTokenProvider(config: PublicConfig, refreshToken: string): TokenProvider {
  const pool = new CognitoUserPool({
    UserPoolId: config.userPoolId,
    ClientId: config.userPoolClientId,
  });
  // Username is unused for a refresh call, but CognitoUser requires one.
  const refresh = (rt: string) =>
    new Promise<LoginResult>((resolve, reject) => {
      const user = new CognitoUser({ Username: 'stored', Pool: pool });
      user.refreshSession(new CognitoRefreshToken({ RefreshToken: rt }), (err, s) => {
        if (err || !s) return reject(err ?? new Error('no session'));
        resolve({
          idToken: s.getIdToken().getJwtToken(),
          refreshToken: s.getRefreshToken().getToken(),
          expiresAtMs: s.getIdToken().getExpiration() * 1000,
        });
      });
    });
  return makeStoredTokenProvider(refreshToken, refresh);
}
