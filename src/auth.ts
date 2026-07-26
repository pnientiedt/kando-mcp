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

export function srpTokenProvider(
  config: PublicConfig,
  creds: { email: string; password: string },
): TokenProvider {
  const pool = new CognitoUserPool({
    UserPoolId: config.userPoolId,
    ClientId: config.userPoolClientId,
  });
  const user = () => new CognitoUser({ Username: creds.email, Pool: pool });

  const login = () =>
    new Promise<LoginResult>((resolve, reject) => {
      user().authenticateUser(
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
