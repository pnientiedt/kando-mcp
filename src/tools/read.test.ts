import { describe, it, expect, vi } from 'vitest';
import { resolveBoardId, selectBoardFields, registerReadTools, type ToolHost } from './read.js';

/** A capturing ToolHost: records each tool's callback and config by name. */
function captureHost() {
  const tools: Record<string, (args: any) => Promise<any>> = {};
  const configs: Record<string, any> = {};
  const host: ToolHost = {
    registerTool(name, config, cb) {
      tools[name] = cb;
      configs[name] = config;
      return undefined;
    },
  };
  return { host, tools, configs };
}

/** A board whose every item carries a large body — the thing we must not ship. */
function fatBoard(n = 62) {
  const BODY = 'X'.repeat(9000);
  const stories = Array.from({ length: n }, (_, i) => ({
    id: `s${i}`,
    num: i + 1,
    columnId: i % 2 ? 'done' : 'open',
    title: `Story ${i}`,
    body: BODY,
    tags: ['t1'],
    assignee: 'u1',
    releaseId: null,
    visibleAt: null,
    archivedAt: null,
    rank: 'a',
    subtasks: [],
  }));
  return {
    getBoard: {
      board: {
        id: 'b1',
        key: 'KDO',
        name: 'Kando',
        role: 'EDITOR',
        columns: [
          { id: 'open', label: 'Open', order: 0 },
          { id: 'done', label: 'Done', order: 1 },
        ],
      },
      stories,
      tags: [{ id: 't1', name: 'refined' }],
      releases: [],
      members: [{ userSub: 'u1', email: 'bot@example.com', displayName: 'Bot', role: 'EDITOR' }],
    },
  };
}

const gqlFor = (payload: any) => async (q: string) =>
  q.includes('myBoards') ? { myBoards: [{ id: 'b1', key: 'KDO' }] } : payload;

describe('resolveBoardId', () => {
  it('passes a raw board id through unchanged', async () => {
    const gql = vi.fn();
    expect(await resolveBoardId(gql as never, 'b-uuid-123')).toBe('b-uuid-123');
    expect(gql).not.toHaveBeenCalled();
  });

  it('resolves a board KEY to its id via myBoards', async () => {
    const gql = vi.fn(async () => ({ myBoards: [{ id: 'b1', key: 'TSK' }, { id: 'b2', key: 'PRD' }] }));
    expect(await resolveBoardId(gql as never, 'PRD')).toBe('b2');
  });

  it('throws when the key is unknown', async () => {
    const gql = vi.fn(async () => ({ myBoards: [{ id: 'b1', key: 'TSK' }] }));
    await expect(resolveBoardId(gql as never, 'ZZZ')).rejects.toThrow(/no board/i);
  });
});

describe('selectBoardFields', () => {
  const full = {
    board: { id: 'b1' },
    items: [{ ticket: 'TSK-1' }],
    tags: [{ id: 't1' }],
    releases: [{ id: 'r1' }],
    members: [{ userSub: 'u1' }],
  };

  it('returns every section when no fields are given', () => {
    expect(selectBoardFields(full)).toEqual(full);
  });

  it('returns only the requested sections', () => {
    expect(selectBoardFields(full, ['board', 'members'])).toEqual({
      board: { id: 'b1' },
      members: [{ userSub: 'u1' }],
    });
  });

  it('treats an empty list as every section, never as nothing', () => {
    expect(selectBoardFields(full, [])).toEqual(full);
  });
});

describe('get_board is lean', () => {
  it('never emits a body, and keeps Done items', async () => {
    const { host, tools } = captureHost();
    registerReadTools(host, gqlFor(fatBoard()) as never);
    const text = (await tools.get_board({ board: 'KDO' })).content[0].text;
    expect(text).not.toContain('XXXX');
    expect(text).not.toContain('"body"');
    const out = JSON.parse(text);
    expect(out.items).toHaveLength(62);
    expect(out.items.some((i: any) => i.col === 'Done')).toBe(true);
  });

  it('renders columns, tags and members in human-readable form', async () => {
    const { host, tools } = captureHost();
    registerReadTools(host, gqlFor(fatBoard(1)) as never);
    const out = JSON.parse((await tools.get_board({ board: 'KDO' })).content[0].text);
    expect(out.board.columns).toEqual(['Open', 'Done']);
    expect(out.tags).toEqual(['refined']);
    expect(out.items[0]).toEqual({
      ticket: 'KDO-1',
      title: 'Story 0',
      col: 'Open',
      tags: ['refined'],
      assignee: 'bot@example.com',
    });
    expect(out.members).toEqual([{ email: 'bot@example.com', name: 'Bot', role: 'EDITOR' }]);
  });

  it('stays inside its size budget on a 62-item board', async () => {
    const { host, tools } = captureHost();
    registerReadTools(host, gqlFor(fatBoard()) as never);
    const text = (await tools.get_board({ board: 'KDO' })).content[0].text;
    // Measured ~10,000 chars on the real KDO board; the budget adds headroom.
    // If this fails, a fat field has crept back into the list response.
    expect(text.length).toBeLessThan(12000);
  });

  it('is compact JSON, not pretty-printed', async () => {
    const { host, tools } = captureHost();
    registerReadTools(host, gqlFor(fatBoard(1)) as never);
    expect((await tools.get_board({ board: 'KDO' })).content[0].text).not.toContain('\n  ');
  });
});

describe('search_tickets is lean', () => {
  it('filters on body text but never returns it', async () => {
    const { host, tools } = captureHost();
    registerReadTools(host, gqlFor(fatBoard(3)) as never);
    const text = (await tools.search_tickets({ board: 'KDO', text: 'XXX' })).content[0].text;
    expect(JSON.parse(text)).toHaveLength(3);
    expect(text).not.toContain('"body"');
  });

  it('accepts a tag NAME for the tag filter', async () => {
    const { host, tools } = captureHost();
    registerReadTools(host, gqlFor(fatBoard(3)) as never);
    const out = JSON.parse(
      (await tools.search_tickets({ board: 'KDO', tag: 'refined' })).content[0].text,
    );
    expect(out).toHaveLength(3);
  });
});

describe('get_ticket', () => {
  const container = () => ({
    getBoard: {
      board: {
        id: 'b1',
        key: 'KDO',
        name: 'Kando',
        role: 'EDITOR',
        columns: [{ id: 'open', label: 'Open', order: 0 }],
      },
      stories: [
        {
          id: 's1',
          num: 54,
          columnId: 'open',
          title: 'Parent',
          body: 'PARENT SPEC',
          tags: [],
          assignee: null,
          releaseId: null,
          visibleAt: null,
          archivedAt: null,
          subtasks: [
            {
              id: 'sub1',
              num: 55,
              storyId: 's1',
              columnId: 'open',
              title: 'Child',
              body: 'CHILD SPEC',
              tags: [],
              assignee: null,
              releaseId: null,
              visibleAt: null,
              archivedAt: null,
            },
          ],
        },
      ],
      tags: [],
      releases: [],
      members: [],
    },
  });

  const gqlTicket = (payload: any, ref: any) => async (q: string) =>
    q.includes('resolveTicket') ? { resolveTicket: ref } : payload;

  it('returns the requested body and lean, body-less subtasks', async () => {
    const { host, tools } = captureHost();
    registerReadTools(
      host,
      gqlTicket(container(), { boardId: 'b1', storyId: 's1', subtaskId: null }) as never,
    );
    const text = (await tools.get_ticket({ ticket: 'KDO-54' })).content[0].text;
    const out = JSON.parse(text);
    expect(out.body).toBe('PARENT SPEC');
    expect(out.subtasks).toEqual([
      { ticket: 'KDO-55', title: 'Child', col: 'Open', parent: 'KDO-54' },
    ]);
    expect(text).not.toContain('CHILD SPEC');
  });

  it("returns a subtask's own body and its parent, not its siblings", async () => {
    const { host, tools } = captureHost();
    registerReadTools(
      host,
      gqlTicket(container(), { boardId: 'b1', storyId: 's1', subtaskId: 'sub1' }) as never,
    );
    const out = JSON.parse((await tools.get_ticket({ ticket: 'KDO-55' })).content[0].text);
    expect(out).toMatchObject({
      ticket: 'KDO-55',
      kind: 'subtask',
      parent: 'KDO-54',
      body: 'CHILD SPEC',
    });
    expect(out.subtasks).toBeUndefined();
  });
});
