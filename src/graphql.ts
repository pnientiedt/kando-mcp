import type { PublicConfig } from './config.js';
import type { TokenProvider } from './auth.js';

export class KandoError extends Error {
  token?: string;
  constructor(message: string, token?: string) {
    super(message);
    this.name = 'KandoError';
    this.token = token;
  }
}

const MESSAGES: Record<string, string> = {
  BAD_INPUT: "That didn't save — a title/description is too long or a value isn't valid.",
  UNAUTHORIZED: 'The bot lacks permission on this board (needs EDITOR to write, VIEWER to read).',
  UNAUTHENTICATED: 'The bot session expired and could not be renewed.',
  NOT_FOUND: 'That no longer exists — it may have been deleted.',
  KEY_TAKEN: 'That board key is already taken.',
  CONFLICT: 'Someone else just changed this. Re-read and try again.',
  LAST_OWNER: 'A board must keep at least one owner.',
  TOO_BROAD:
    'That search covers too many boards. Name the boards you mean with `boards`, or narrow the filter.',
};
const FALLBACK = 'Something went wrong; the change was not saved.';

/** The resolver encodes domain failures as a bare token in the error message. */
export function extractToken(message: string): string | undefined {
  const m = message.match(/[A-Z][A-Z_]{2,}/);
  return m ? m[0] : undefined;
}

export function mapErrorToken(token?: string): string {
  return (token && MESSAGES[token]) || FALLBACK;
}

export type GqlClient = (query: string, variables?: Record<string, unknown>) => Promise<any>;

export interface GqlOptions {
  fetch?: typeof fetch;
  /** Injectable delay (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>;
  /** Extra attempts after the first, for transient failures. Default 2. */
  retries?: number;
  /** Per-request timeout in ms. Default 15000. */
  timeoutMs?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const backoffMs = (attempt: number) => 100 * 2 ** attempt; // 100, 200, 400…
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * AppSync GraphQL client that never lets a transient failure escape as a raw
 * rejection: it times out a hung request, retries socket errors / 5xx with
 * backoff, and forces one token refresh on a 401. Deterministic failures
 * (4xx, GraphQL domain errors) are surfaced immediately as a KandoError.
 */
export function makeGqlClient(
  config: PublicConfig,
  tp: TokenProvider,
  opts: GqlOptions = {},
): GqlClient {
  const doFetch = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const retries = opts.retries ?? 2;
  const timeoutMs = opts.timeoutMs ?? 15_000;

  async function attemptFetch(query: string, variables: Record<string, unknown>): Promise<Response> {
    const token = await tp.getIdToken();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await doFetch(config.graphqlUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: token },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  return async function gql(query, variables = {}) {
    let refreshed = false;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      let res: Response;
      try {
        res = await attemptFetch(query, variables);
      } catch (e) {
        // Network error / timeout / abort — transient.
        lastErr = new KandoError(`Network error contacting Kando: ${errMsg(e)}`);
        if (attempt < retries) {
          await sleep(backoffMs(attempt));
          continue;
        }
        throw lastErr;
      }

      if (res.status === 401) {
        // Token may have been revoked — force one re-auth and retry.
        if (!refreshed && attempt < retries) {
          refreshed = true;
          tp.invalidate?.();
          continue;
        }
        throw new KandoError(mapErrorToken('UNAUTHENTICATED'), 'UNAUTHENTICATED');
      }

      if (res.status >= 500) {
        lastErr = new KandoError(`AppSync HTTP ${res.status}`);
        if (attempt < retries) {
          await sleep(backoffMs(attempt));
          continue;
        }
        throw lastErr;
      }

      if (!res.ok) throw new KandoError(`AppSync HTTP ${res.status}`);

      const json = (await res.json()) as { data?: any; errors?: Array<{ message: string }> };
      if (json.errors && json.errors.length) {
        // Domain error — deterministic, do NOT retry.
        const raw = json.errors[0].message;
        const tok = extractToken(raw);
        throw new KandoError(mapErrorToken(tok), tok);
      }
      return json.data;
    }
    throw lastErr ?? new KandoError('Request failed after retries');
  };
}
