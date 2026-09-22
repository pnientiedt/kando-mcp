import { describe, it, expect } from 'vitest';
import { registerDecisionTools } from './decisions.js';
import type { ToolHost } from './read.js';

/** A capturing ToolHost: records each tool's callback by name (registry.test.ts style). */
function captureHost() {
  const tools: Record<string, (args: any) => Promise<any>> = {};
  const host: ToolHost = {
    registerTool(name, _config, cb) {
      tools[name] = cb;
      return undefined;
    },
  };
  return { host, tools };
}

const parse = (res: any) => JSON.parse(res.content[0].text);

/** A board carrying one member to resolve "me" against. */
const BOARD = {
  getBoard: {
    board: { id: 'b1', key: 'KDO', name: 'Kando', role: 'EDITOR', columns: [] },
    stories: [],
    tags: [],
    releases: [],
    members: [{ userSub: 'u1', email: 'bot@example.com', role: 'EDITOR' }],
  },
};

describe('create_decision', () => {
  it('creates a decision and returns its KEY-D-N', async () => {
    const calls: Array<{ q: string; v: any }> = [];
    const gql = async (q: string, v: any = {}) => {
      calls.push({ q, v });
      if (q.includes('myBoards')) return { myBoards: [{ id: 'b1', key: 'KDO' }] };
      if (q.includes('getBoard')) return BOARD;
      if (q.includes('createDecision')) {
        return { createDecision: { boardId: 'b1', decision: { id: '5', num: 5, boardId: 'b1', title: 'Pick a stack' } } };
      }
      throw new Error(`unexpected query: ${q}`);
    };
    const { host, tools } = captureHost();
    registerDecisionTools(host, gql as never, null);
    const out = parse(
      await tools.create_decision({
        board: 'KDO',
        title: 'Pick a stack',
        options: [{ label: 'Postgres' }, { label: 'DynamoDB' }],
      }),
    );
    expect(out).toEqual({ decision: 'KDO-D-5', title: 'Pick a stack' });
    const create = calls.find((c) => c.q.includes('createDecision'));
    expect(create!.v).toMatchObject({
      boardId: 'b1',
      title: 'Pick a stack',
      options: [{ label: 'Postgres' }, { label: 'DynamoDB' }],
    });
  });

  it('resolves assignee "me" against the authenticated bot email', async () => {
    const calls: Array<{ q: string; v: any }> = [];
    const gql = async (q: string, v: any = {}) => {
      calls.push({ q, v });
      if (q.includes('myBoards')) return { myBoards: [{ id: 'b1', key: 'KDO' }] };
      if (q.includes('getBoard')) return BOARD;
      if (q.includes('createDecision')) return { createDecision: { boardId: 'b1', decision: { id: '1', num: 1 } } };
      throw new Error(`unexpected query: ${q}`);
    };
    const { host, tools } = captureHost();
    registerDecisionTools(host, gql as never, 'bot@example.com');
    await tools.create_decision({ board: 'KDO', title: 'x', options: [{ label: 'a' }], assignee: 'me' });
    const create = calls.find((c) => c.q.includes('createDecision'));
    expect(create!.v.assignee).toBe('u1');
  });

  it('rejects zero options before calling the server', async () => {
    const gql = async (q: string) => {
      throw new Error(`should not be called: ${q}`);
    };
    const { host, tools } = captureHost();
    registerDecisionTools(host, gql as never, null);
    await expect(
      tools.create_decision({ board: 'KDO', title: 'x', options: [] }),
    ).rejects.toThrow(/at least one option/i);
  });

  it('rejects more than 10 keywords before calling the server', async () => {
    const gql = async (q: string) => {
      throw new Error(`should not be called: ${q}`);
    };
    const { host, tools } = captureHost();
    registerDecisionTools(host, gql as never, null);
    await expect(
      tools.create_decision({
        board: 'KDO',
        title: 'x',
        options: [{ label: 'a' }],
        keywords: Array.from({ length: 11 }, (_, i) => `k${i}`),
      }),
    ).rejects.toThrow(/at most 10 keywords/i);
  });

  it('rejects a keyword over 40 characters before calling the server', async () => {
    const gql = async (q: string) => {
      throw new Error(`should not be called: ${q}`);
    };
    const { host, tools } = captureHost();
    registerDecisionTools(host, gql as never, null);
    await expect(
      tools.create_decision({
        board: 'KDO',
        title: 'x',
        options: [{ label: 'a' }],
        keywords: ['x'.repeat(41)],
      }),
    ).rejects.toThrow(/40 characters/i);
  });
});

describe('list_decisions', () => {
  it('defaults to filter relevant, mapped to the backend RELEVANT enum', async () => {
    const calls: Array<{ q: string; v: any }> = [];
    const gql = async (q: string, v: any = {}) => {
      calls.push({ q, v });
      if (q.includes('myBoards')) return { myBoards: [{ id: 'b1', key: 'KDO' }] };
      if (q.includes('getBoard')) return BOARD;
      if (q.includes('listDecisions')) {
        return {
          listDecisions: {
            items: [{ id: '1', num: 1, boardId: 'b1', title: 'A', options: [], keywords: [], status: 'OPEN' }],
            nextCursor: null,
            totalCount: 1,
          },
        };
      }
      throw new Error(`unexpected query: ${q}`);
    };
    const { host, tools } = captureHost();
    registerDecisionTools(host, gql as never, null);
    const out = parse(await tools.list_decisions({ board: 'KDO' }));
    expect(out).toEqual({
      decisions: [
        {
          decision: 'KDO-D-1',
          title: 'A',
          description: null,
          options: [],
          assignee: null,
          status: 'OPEN',
          resolution: null,
          keywords: [],
        },
      ],
      totalCount: 1,
    });
    const list = calls.find((c) => c.q.includes('listDecisions'));
    expect(list!.v.filter).toBe('RELEVANT');
  });

  it('passes correctedReasoning through on options, untouched', async () => {
    const calls: Array<{ q: string; v: any }> = [];
    const gql = async (q: string, v: any = {}) => {
      calls.push({ q, v });
      if (q.includes('myBoards')) return { myBoards: [{ id: 'b1', key: 'KDO' }] };
      if (q.includes('getBoard')) return BOARD;
      if (q.includes('listDecisions')) {
        return {
          listDecisions: {
            items: [
              {
                id: '1', num: 1, boardId: 'b1', title: 'A',
                options: [{ id: 'o1', label: 'Postgres', isCustom: false, correctedReasoning: 'actually because X' }],
                keywords: [], status: 'RESOLVED',
              },
            ],
            nextCursor: null,
            totalCount: 1,
          },
        };
      }
      throw new Error(`unexpected query: ${q}`);
    };
    const { host, tools } = captureHost();
    registerDecisionTools(host, gql as never, null);
    const out = parse(await tools.list_decisions({ board: 'KDO' }));
    expect(out.decisions[0].options[0].correctedReasoning).toBe('actually because X');
  });

  it('passes keyword and cursor through, and reports nextCursor when present', async () => {
    const calls: Array<{ q: string; v: any }> = [];
    const gql = async (q: string, v: any = {}) => {
      calls.push({ q, v });
      if (q.includes('myBoards')) return { myBoards: [{ id: 'b1', key: 'KDO' }] };
      if (q.includes('getBoard')) return BOARD;
      if (q.includes('listDecisions')) return { listDecisions: { items: [], nextCursor: 'c2', totalCount: 0 } };
      throw new Error(`unexpected query: ${q}`);
    };
    const { host, tools } = captureHost();
    registerDecisionTools(host, gql as never, null);
    const out = parse(await tools.list_decisions({ board: 'KDO', keyword: 'infra', cursor: 'c1', filter: 'all' }));
    expect(out).toEqual({ decisions: [], totalCount: 0, nextCursor: 'c2' });
    const list = calls.find((c) => c.q.includes('listDecisions'));
    expect(list!.v).toMatchObject({ boardId: 'b1', filter: 'ALL', keyword: 'infra', cursor: 'c1' });
  });

  it('rejects resolvedAfter outside filter:history, before any network call', async () => {
    const gql = async (q: string) => {
      throw new Error(`should not be called: ${q}`);
    };
    const { host, tools } = captureHost();
    registerDecisionTools(host, gql as never, null);
    await expect(
      tools.list_decisions({ board: 'KDO', resolvedAfter: '2026-01-01T00:00:00.000Z' }),
    ).rejects.toThrow(/resolvedAfter.*history/i);
    await expect(
      tools.list_decisions({ board: 'KDO', filter: 'all', resolvedAfter: '2026-01-01T00:00:00.000Z' }),
    ).rejects.toThrow(/resolvedAfter.*history/i);
  });

  it('history: latestResolvedAt is the max resolvedAt on the page, feedable as the next resolvedAfter', async () => {
    const gql = async (q: string, v: any = {}) => {
      if (q.includes('myBoards')) return { myBoards: [{ id: 'b1', key: 'KDO' }] };
      if (q.includes('getBoard')) return BOARD;
      if (q.includes('listDecisions')) {
        if (!v.resolvedAfter) {
          return {
            listDecisions: {
              items: [
                {
                  id: '1', num: 1, boardId: 'b1', title: 'A', options: [], keywords: [], status: 'RESOLVED',
                  resolution: { chosenOptionId: 'o1', resolvedBy: 'u1', resolvedAt: '2026-01-01T00:00:00.000Z' },
                },
                {
                  id: '2', num: 2, boardId: 'b1', title: 'B', options: [], keywords: [], status: 'RESOLVED',
                  resolution: { chosenOptionId: 'o2', resolvedBy: 'u1', resolvedAt: '2026-01-02T00:00:00.000Z' },
                },
              ],
              nextCursor: null,
              totalCount: 2,
            },
          };
        }
        // Simulates the backend's own resolvedAfter filtering: only what's newer.
        return {
          listDecisions: {
            items: [
              {
                id: '2', num: 2, boardId: 'b1', title: 'B', options: [], keywords: [], status: 'RESOLVED',
                resolution: { chosenOptionId: 'o2', resolvedBy: 'u1', resolvedAt: '2026-01-02T00:00:00.000Z' },
              },
            ],
            nextCursor: null,
            totalCount: 1,
          },
        };
      }
      throw new Error(`unexpected query: ${q}`);
    };
    const { host, tools } = captureHost();
    registerDecisionTools(host, gql as never, null);
    const first = parse(await tools.list_decisions({ board: 'KDO', filter: 'history' }));
    expect(first.latestResolvedAt).toBe('2026-01-02T00:00:00.000Z');
    const second = parse(
      await tools.list_decisions({ board: 'KDO', filter: 'history', resolvedAfter: first.latestResolvedAt }),
    );
    expect(second.decisions.map((d: any) => d.decision)).toEqual(['KDO-D-2']);
  });

  it('omits latestResolvedAt for non-history filters', async () => {
    const gql = async (q: string) => {
      if (q.includes('myBoards')) return { myBoards: [{ id: 'b1', key: 'KDO' }] };
      if (q.includes('getBoard')) return BOARD;
      if (q.includes('listDecisions')) return { listDecisions: { items: [], nextCursor: null, totalCount: 0 } };
      throw new Error(`unexpected query: ${q}`);
    };
    const { host, tools } = captureHost();
    registerDecisionTools(host, gql as never, null);
    const out = parse(await tools.list_decisions({ board: 'KDO', filter: 'all' }));
    expect(out).not.toHaveProperty('latestResolvedAt');
  });
});

describe('resolve_decision', () => {
  const gqlWithOptions = (calls: Array<{ q: string; v: any }>) => async (q: string, v: any = {}) => {
    calls.push({ q, v });
    if (q.includes('resolveDecisionRef')) {
      return {
        resolveDecisionRef: {
          boardId: 'b1',
          decision: {
            id: '5', num: 5, boardId: 'b1',
            options: [
              { id: 'o1', label: 'Postgres', isCustom: false },
              { id: 'o2', label: 'DynamoDB', isCustom: false },
            ],
          },
        },
      };
    }
    if (q.includes('resolveDecision')) {
      return { resolveDecision: { boardId: 'b1', decision: { id: '5', num: 5, boardId: 'b1' } } };
    }
    throw new Error(`unexpected query: ${q}`);
  };

  it('resolves via chosenOption matched by label', async () => {
    const calls: Array<{ q: string; v: any }> = [];
    const gql = gqlWithOptions(calls);
    const { host, tools } = captureHost();
    registerDecisionTools(host, gql as never, null);
    const out = parse(await tools.resolve_decision({ decision: 'KDO-D-5', chosenOption: 'Postgres' }));
    expect(out).toEqual({ decision: 'KDO-D-5', resolved: 'Postgres' });
    const call = calls.find((c) => c.q.includes('resolveDecision(') || (c.q.includes('resolveDecision') && !c.q.includes('resolveDecisionRef')));
    expect(call!.v).toMatchObject({ boardId: 'b1', decisionId: '5', chosenOptionId: 'o1' });
  });

  it('resolves via chosenOption matched by raw id when no label matches', async () => {
    const calls: Array<{ q: string; v: any }> = [];
    const gql = gqlWithOptions(calls);
    const { host, tools } = captureHost();
    registerDecisionTools(host, gql as never, null);
    const out = parse(await tools.resolve_decision({ decision: 'KDO-D-5', chosenOption: 'o2' }));
    expect(out).toEqual({ decision: 'KDO-D-5', resolved: 'DynamoDB' });
  });

  it('resolves via customOption', async () => {
    const calls: Array<{ q: string; v: any }> = [];
    const gql = gqlWithOptions(calls);
    const { host, tools } = captureHost();
    registerDecisionTools(host, gql as never, null);
    const out = parse(
      await tools.resolve_decision({ decision: 'KDO-D-5', customOption: { label: 'Something else', reasoning: 'because' } }),
    );
    expect(out).toEqual({ decision: 'KDO-D-5', resolved: 'Something else' });
    const call = calls.find((c) => c.q.includes('resolveDecision') && !c.q.includes('resolveDecisionRef'));
    expect(call!.v.customOption).toEqual({ label: 'Something else', reasoning: 'because' });
    expect(call!.v.chosenOptionId).toBeUndefined();
  });

  it('sends correctedReasoning when provided alongside chosenOption', async () => {
    const calls: Array<{ q: string; v: any }> = [];
    const gql = gqlWithOptions(calls);
    const { host, tools } = captureHost();
    registerDecisionTools(host, gql as never, null);
    await tools.resolve_decision({ decision: 'KDO-D-5', chosenOption: 'Postgres', correctedReasoning: 'actually because X' });
    const call = calls.find((c) => c.q.includes('resolveDecision') && !c.q.includes('resolveDecisionRef'));
    expect(call!.v.correctedReasoning).toBe('actually because X');
  });

  it('sends correctedReasoning as empty string to clear it', async () => {
    const calls: Array<{ q: string; v: any }> = [];
    const gql = gqlWithOptions(calls);
    const { host, tools } = captureHost();
    registerDecisionTools(host, gql as never, null);
    await tools.resolve_decision({ decision: 'KDO-D-5', chosenOption: 'Postgres', correctedReasoning: '' });
    const call = calls.find((c) => c.q.includes('resolveDecision') && !c.q.includes('resolveDecisionRef'));
    expect(call!.v.correctedReasoning).toBe('');
  });

  it('omits correctedReasoning entirely when not provided', async () => {
    const calls: Array<{ q: string; v: any }> = [];
    const gql = gqlWithOptions(calls);
    const { host, tools } = captureHost();
    registerDecisionTools(host, gql as never, null);
    await tools.resolve_decision({ decision: 'KDO-D-5', chosenOption: 'Postgres' });
    const call = calls.find((c) => c.q.includes('resolveDecision') && !c.q.includes('resolveDecisionRef'));
    expect(call!.v).not.toHaveProperty('correctedReasoning');
  });

  it('rejects correctedReasoning with customOption before any network call', async () => {
    const calls: string[] = [];
    const gql = async (q: string) => {
      calls.push(q);
      throw new Error('should not be called');
    };
    const { host, tools } = captureHost();
    registerDecisionTools(host, gql as never, null);
    await expect(
      tools.resolve_decision({
        decision: 'KDO-D-5',
        customOption: { label: 'y' },
        correctedReasoning: 'text',
      }),
    ).rejects.toThrow(/correctedReasoning/i);
    expect(calls).toHaveLength(0);
  });

  it('rejects both chosenOption and customOption before any network call', async () => {
    const calls: string[] = [];
    const gql = async (q: string) => {
      calls.push(q);
      throw new Error('should not be called');
    };
    const { host, tools } = captureHost();
    registerDecisionTools(host, gql as never, null);
    await expect(
      tools.resolve_decision({ decision: 'KDO-D-5', chosenOption: 'x', customOption: { label: 'y' } }),
    ).rejects.toThrow(/exactly one/i);
    expect(calls).toHaveLength(0);
  });

  it('rejects neither chosenOption nor customOption before any network call', async () => {
    const calls: string[] = [];
    const gql = async (q: string) => {
      calls.push(q);
      throw new Error('should not be called');
    };
    const { host, tools } = captureHost();
    registerDecisionTools(host, gql as never, null);
    await expect(tools.resolve_decision({ decision: 'KDO-D-5' })).rejects.toThrow(/exactly one/i);
    expect(calls).toHaveLength(0);
  });

  it('rejects an unknown chosenOption name/id with a clear error', async () => {
    const calls: Array<{ q: string; v: any }> = [];
    const gql = gqlWithOptions(calls);
    const { host, tools } = captureHost();
    registerDecisionTools(host, gql as never, null);
    await expect(tools.resolve_decision({ decision: 'KDO-D-5', chosenOption: 'Nope' })).rejects.toThrow(
      /no option/i,
    );
  });

  it('rejects a malformed decision ref without calling the server', async () => {
    const gql = async (q: string) => {
      throw new Error(`should not be called: ${q}`);
    };
    const { host, tools } = captureHost();
    registerDecisionTools(host, gql as never, null);
    await expect(tools.resolve_decision({ decision: 'KDO-5', chosenOption: 'x' })).rejects.toThrow(
      /Not a decision id/,
    );
  });
});

describe('reopen_decision', () => {
  it('reopens a decision', async () => {
    const gql = async (q: string) => {
      if (q.includes('resolveDecisionRef')) {
        return { resolveDecisionRef: { boardId: 'b1', decision: { id: '5', num: 5, boardId: 'b1' } } };
      }
      if (q.includes('reopenDecision')) return { reopenDecision: { boardId: 'b1', decision: { id: '5', num: 5 } } };
      throw new Error(`unexpected query: ${q}`);
    };
    const { host, tools } = captureHost();
    registerDecisionTools(host, gql as never, null);
    const out = parse(await tools.reopen_decision({ decision: 'KDO-D-5' }));
    expect(out).toEqual({ decision: 'KDO-D-5', reopened: true });
  });

  it('rejects a malformed decision ref without calling the server', async () => {
    const gql = async (q: string) => {
      throw new Error(`should not be called: ${q}`);
    };
    const { host, tools } = captureHost();
    registerDecisionTools(host, gql as never, null);
    await expect(tools.reopen_decision({ decision: 'KDO-5' })).rejects.toThrow(/Not a decision id/);
  });
});
