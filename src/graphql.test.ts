import { describe, it, expect, vi } from 'vitest';
import { makeGqlClient, mapErrorToken } from './graphql.js';

const config = {
  region: 'eu-central-1',
  userPoolId: 'x',
  userPoolClientId: 'y',
  graphqlUrl: 'https://appsync.example/graphql',
};
const noSleep = async () => {};
const tokenProvider = () => ({ getIdToken: async () => 'ID_TOKEN', invalidate: vi.fn() });

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('graphql client', () => {
  it('sends the token and returns data', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: { myBoards: [{ id: 'b1' }] } }));
    const gql = makeGqlClient(config, tokenProvider(), { fetch: fetchImpl as unknown as typeof fetch });
    const data = await gql('query { myBoards { id } }');
    expect(data.myBoards[0].id).toBe('b1');
    const init = (fetchImpl.mock.calls[0] as unknown[])[1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('ID_TOKEN');
  });

  it('throws KandoError carrying the resolver token and does NOT retry domain errors', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ errors: [{ message: 'UNAUTHORIZED' }] }));
    const gql = makeGqlClient(config, tokenProvider(), { fetch: fetchImpl as unknown as typeof fetch, sleep: noSleep });
    await expect(gql('query {}')).rejects.toMatchObject({ token: 'UNAUTHORIZED' });
    expect(fetchImpl).toHaveBeenCalledTimes(1); // deterministic → no retry
  });

  it('maps known tokens to readable text', () => {
    expect(mapErrorToken('NOT_FOUND')).toMatch(/no longer exists/i);
    expect(mapErrorToken('WAT')).toMatch(/something went wrong/i);
    expect(mapErrorToken(undefined)).toMatch(/something went wrong/i);
    // A read that fanned out too far. Without an entry it fell through to the
    // write-shaped fallback ("the change was not saved"), which is wrong twice.
    expect(mapErrorToken('TOO_BROAD')).toMatch(/boards/i);
    expect(mapErrorToken('TOO_BROAD')).not.toMatch(/not saved/i);
  });

  it('retries a 5xx and then succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, 503))
      .mockResolvedValueOnce(jsonResponse({ data: { ok: true } }));
    const gql = makeGqlClient(config, tokenProvider(), { fetch: fetchImpl as unknown as typeof fetch, sleep: noSleep });
    expect(await gql('q')).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('retries a network reject and then succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(jsonResponse({ data: { ok: 1 } }));
    const gql = makeGqlClient(config, tokenProvider(), { fetch: fetchImpl as unknown as typeof fetch, sleep: noSleep });
    expect(await gql('q')).toEqual({ ok: 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('throws after exhausting retries on persistent 5xx', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 500));
    const gql = makeGqlClient(config, tokenProvider(), {
      fetch: fetchImpl as unknown as typeof fetch,
      sleep: noSleep,
      retries: 2,
    });
    await expect(gql('q')).rejects.toThrow(/HTTP 500/);
    expect(fetchImpl).toHaveBeenCalledTimes(3); // 1 + 2 retries
  });

  it('forces a token refresh on 401 then retries', async () => {
    const tp = tokenProvider();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, 401))
      .mockResolvedValueOnce(jsonResponse({ data: { ok: 1 } }));
    const gql = makeGqlClient(config, tp, { fetch: fetchImpl as unknown as typeof fetch, sleep: noSleep });
    expect(await gql('q')).toEqual({ ok: 1 });
    expect(tp.invalidate).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('surfaces UNAUTHENTICATED when a 401 persists past the refresh', async () => {
    const tp = tokenProvider();
    const fetchImpl = vi.fn(async () => jsonResponse({}, 401));
    const gql = makeGqlClient(config, tp, { fetch: fetchImpl as unknown as typeof fetch, sleep: noSleep });
    await expect(gql('q')).rejects.toMatchObject({ token: 'UNAUTHENTICATED' });
  });
});
