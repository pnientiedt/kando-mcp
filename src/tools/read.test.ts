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

describe('search_tickets', () => {
  /** One `getTickets` page: a container story and a snoozed subtask. */
  const page = (over: Record<string, unknown> = {}) => ({
    getTickets: {
      items: [
        {
          ticket: 'KDO-1', parent: null, title: 'Container', columnLabel: 'Open', subtaskCount: 2,
          tags: ['claude'], releaseName: null, assignee: 'sub-1', assigneeEmail: 'bot@example.com',
          visibleAt: null, archivedAt: null,
        },
        {
          ticket: 'KDO-2', parent: 'KDO-1', title: 'Child', columnLabel: 'Open', subtaskCount: 0,
          tags: [], releaseName: null, assignee: null, assigneeEmail: null,
          visibleAt: '2999-01-01T00:00:00Z', archivedAt: null,
        },
      ],
      truncated: false,
      boardsSearched: 1,
      ...over,
    },
  });

  const capture = (data: any) => {
    const calls: Array<{ query: string; variables: any }> = [];
    const gql = vi.fn(async (query: string, variables: any) => {
      calls.push({ query, variables });
      if (query.includes('myBoards')) {
        return { myBoards: [{ id: 'b1', key: 'KDO' }, { id: 'b2', key: 'TSK' }] };
      }
      return data;
    });
    return { calls, gql };
  };

  it('queries getTickets once and never getBoard — the whole point of the rewrite', async () => {
    const { calls, gql } = capture(page());
    const { host, tools } = captureHost();
    registerReadTools(host, gql as never);

    const out = JSON.parse((await tools.search_tickets({})).content[0].text);

    expect(calls).toHaveLength(1);
    expect(calls[0].query).toContain('getTickets');
    expect(calls.some((c) => c.query.includes('getBoard'))).toBe(false);
    expect(out.tickets).toEqual([
      { ticket: 'KDO-1', title: 'Container', col: 'Open', tags: ['claude'], assignee: 'bot@example.com', subtasks: 2 },
      { ticket: 'KDO-2', title: 'Child', col: 'Open', parent: 'KDO-1', snoozed: true },
    ]);
  });

  it('sends no filter and no limit when nothing was asked for', async () => {
    const { calls, gql } = capture(page());
    const { host, tools } = captureHost();
    registerReadTools(host, gql as never);

    await tools.search_tickets({});
    expect(calls[0].variables).toEqual({});
  });

  it('resolves board KEYS to ids in one myBoards read', async () => {
    const { calls, gql } = capture(page());
    const { host, tools } = captureHost();
    registerReadTools(host, gql as never);

    await tools.search_tickets({ boards: ['KDO', 'TSK'] });
    expect(calls.filter((c) => c.query.includes('myBoards'))).toHaveLength(1);
    expect(calls.find((c) => c.query.includes('getTickets'))!.variables.filter.boardIds).toEqual(['b1', 'b2']);
  });

  it('maps the filters and limit onto the query', async () => {
    const { calls, gql } = capture(page());
    const { host, tools } = captureHost();
    registerReadTools(host, gql as never);

    await tools.search_tickets({ assignees: ['me'], archived: 'all', kind: 'story', limit: 5 });
    const q = calls.find((c) => c.query.includes('getTickets'))!;
    expect(q.variables).toEqual({
      filter: { assignees: ['me'], archived: 'ALL', kind: 'STORY' },
      limit: 5,
    });
  });

  it('reports truncation and the fan-out size, and stays silent when neither says anything', async () => {
    const { gql } = capture(page({ truncated: true, boardsSearched: 4 }));
    const { host, tools } = captureHost();
    registerReadTools(host, gql as never);
    const loud = JSON.parse((await tools.search_tickets({})).content[0].text);
    expect(loud.truncated).toBe(true);
    expect(loud.boards).toBe(4);

    const { gql: gql2 } = capture(page());
    const { host: host2, tools: tools2 } = captureHost();
    registerReadTools(host2, gql2 as never);
    const quiet = JSON.parse((await tools2.search_tickets({})).content[0].text);
    expect(quiet).not.toHaveProperty('truncated');
    expect(quiet).not.toHaveProperty('boards');
  });

  it('never returns a body', async () => {
    const { gql } = capture(page());
    const { host, tools } = captureHost();
    registerReadTools(host, gql as never);
    const text = (await tools.search_tickets({ text: 'XXX' })).content[0].text;
    expect(text).not.toContain('"body"');
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

describe('get_ticket on an archived ticket', () => {
  // getBoard drops archived rows entirely (kando infra/lambda/api/boards.ts),
  // so an archived ticket can only be read through archivedItems.
  const archivedStory = {
    id: 's9',
    num: 91,
    columnId: 'open',
    title: 'Archived parent',
    body: 'ARCHIVED SPEC',
    tags: ['t1'],
    assignee: null,
    releaseId: null,
    visibleAt: null,
    archivedAt: '2026-08-02T12:00:00.000Z',
    subtasks: [],
  };
  const archivedChild = {
    id: 'sub9',
    num: 92,
    storyId: 's9',
    columnId: 'open',
    title: 'Archived child',
    body: 'CHILD SPEC',
    tags: [],
    assignee: null,
    releaseId: null,
    visibleAt: null,
    archivedAt: '2026-08-02T12:00:00.000Z',
  };
  const liveBoard = {
    getBoard: {
      board: {
        id: 'b1',
        key: 'KDO',
        name: 'Kando',
        role: 'EDITOR',
        columns: [{ id: 'open', label: 'Open', order: 0 }],
      },
      stories: [],
      tags: [{ id: 't1', name: 'refined' }],
      releases: [],
      members: [],
    },
  };
  const gqlArchived = (ref: any, items: any[]) =>
    vi.fn(async (q: string) => {
      if (q.includes('resolveTicket')) return { resolveTicket: ref };
      if (q.includes('archivedItems')) return { archivedItems: items };
      return liveBoard;
    });

  const bothItems = [
    { archivedAt: archivedStory.archivedAt, story: archivedStory },
    { archivedAt: archivedChild.archivedAt, subtask: archivedChild },
  ];

  it('returns the ticket with its body instead of claiming it is gone', async () => {
    const { host, tools } = captureHost();
    const gql = gqlArchived({ boardId: 'b1', storyId: 's9', subtaskId: null, archived: true }, bothItems);
    registerReadTools(host, gql as never);

    const res = await tools.get_ticket({ ticket: 'KDO-91' });
    expect(res.isError).toBeFalsy();
    const out = JSON.parse(res.content[0].text);
    expect(out).toMatchObject({
      ticket: 'KDO-91',
      kind: 'story',
      title: 'Archived parent',
      body: 'ARCHIVED SPEC',
      archived: true,
      archivedAt: '2026-08-02T12:00:00.000Z',
    });
    // Tag ids still resolve to names via the live board's registries.
    expect(out.tags).toEqual(['refined']);
  });

  it('lists the children that were archived along with it', async () => {
    const { host, tools } = captureHost();
    const gql = gqlArchived({ boardId: 'b1', storyId: 's9', subtaskId: null, archived: true }, bothItems);
    registerReadTools(host, gql as never);

    const out = JSON.parse((await tools.get_ticket({ ticket: 'KDO-91' })).content[0].text);
    expect(out.subtasks).toEqual([
      { ticket: 'KDO-92', title: 'Archived child', col: 'Open', parent: 'KDO-91' },
    ]);
  });

  it('reads an archived subtask on its own', async () => {
    const { host, tools } = captureHost();
    const gql = gqlArchived(
      { boardId: 'b1', storyId: 's9', subtaskId: 'sub9', archived: true },
      bothItems,
    );
    registerReadTools(host, gql as never);

    const out = JSON.parse((await tools.get_ticket({ ticket: 'KDO-92' })).content[0].text);
    expect(out).toMatchObject({
      ticket: 'KDO-92',
      kind: 'subtask',
      body: 'CHILD SPEC',
      archived: true,
    });
    expect(out.subtasks).toBeUndefined();
  });

  it('never reads the archive for a live ticket', async () => {
    const { host, tools } = captureHost();
    const gql = vi.fn(async (q: string) => {
      if (q.includes('resolveTicket')) {
        return { resolveTicket: { boardId: 'b1', storyId: 's1', subtaskId: null, archived: false } };
      }
      if (q.includes('archivedItems')) throw new Error('must not query the archive for a live ticket');
      return {
        getBoard: {
          ...liveBoard.getBoard,
          stories: [{ ...archivedStory, id: 's1', num: 54, archivedAt: null }],
        },
      };
    });
    registerReadTools(host, gql as never);

    const out = JSON.parse((await tools.get_ticket({ ticket: 'KDO-54' })).content[0].text);
    expect(out.archived).toBeUndefined();
    expect(gql.mock.calls.some((c) => String(c[0]).includes('archivedItems'))).toBe(false);
  });

  it('still reports a genuinely deleted ticket as gone', async () => {
    // Resolved as archived, yet absent from the archive: the row is really gone.
    const { host, tools } = captureHost();
    const gql = gqlArchived({ boardId: 'b1', storyId: 'sX', subtaskId: null, archived: true }, []);
    registerReadTools(host, gql as never);

    await expect(tools.get_ticket({ ticket: 'KDO-999' })).rejects.toThrow(/no longer exists/i);
  });
});

describe('tool descriptions state the new contract', () => {
  it('get_board and search_tickets point at get_ticket for bodies', () => {
    const { host, configs } = captureHost();
    registerReadTools(host, (async () => ({})) as never);
    expect(configs.get_board.description).toMatch(/get_ticket/);
    expect(configs.get_board.description).not.toMatch(/userSub/);
    expect(configs.search_tickets.description).toMatch(/get_ticket/);
  });
});

describe('get_ticket comments', () => {
  const board = (num = 34) => ({
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
          num,
          title: 'Story',
          body: 'the spec',
          columnId: 'open',
          tags: [],
          assignee: null,
          releaseId: null,
          visibleAt: null,
          archivedAt: null,
          rank: 'a',
          subtasks: [],
        },
      ],
      tags: [],
      releases: [],
      members: [{ userSub: 'u1', email: 'bot@example.com', role: 'EDITOR' }],
    },
  });

  const comment = (n: number) => ({
    id: `KDO-34-${n}`,
    author: 'u1',
    text: `c${n}`,
    createdAt: '2026-07-28T10:00:00.000Z',
    editedAt: null,
  });

  /**
   * One ordered timeline of `<call>:start` / `<call>:end` events. A single log is
   * what makes overlap observable — comparing positions across two separate
   * arrays says nothing about which happened first.
   */
  function ticketGql(comments: any[]) {
    const log: string[] = [];
    const gql = async (q: string) => {
      const name = q.includes('resolveTicket')
        ? 'resolve'
        : q.includes('getBoard')
          ? 'board'
          : 'comments';
      log.push(`${name}:start`);
      await new Promise((r) => setTimeout(r, 0));
      log.push(`${name}:end`);
      if (name === 'resolve') return { resolveTicket: { boardId: 'b1', storyId: 's1' } };
      if (name === 'board') return board();
      return { comments };
    };
    return { gql, log };
  }

  const parseOut = (res: any) => JSON.parse(res.content[0].text);

  it('inlines comments alongside the body', async () => {
    const { gql } = ticketGql([comment(1)]);
    const { host, tools } = captureHost();
    registerReadTools(host, gql as never);
    const out = parseOut(await tools.get_ticket({ ticket: 'KDO-34' }));
    expect(out.body).toBe('the spec');
    expect(out.comments).toEqual([
      {
        comment: 'KDO-34-1',
        author: 'bot@example.com',
        at: '2026-07-28T10:00:00.000Z',
        text: 'c1',
      },
    ]);
    expect(out).not.toHaveProperty('earlierComments');
  });

  it('omits both keys entirely when the ticket has no comments', async () => {
    const { gql } = ticketGql([]);
    const { host, tools } = captureHost();
    registerReadTools(host, gql as never);
    const out = parseOut(await tools.get_ticket({ ticket: 'KDO-34' }));
    expect(out).not.toHaveProperty('comments');
    expect(out).not.toHaveProperty('earlierComments');
  });

  it('inlines the last 10 and reports the rest as earlierComments', async () => {
    const { gql } = ticketGql(Array.from({ length: 17 }, (_, i) => comment(i + 1)));
    const { host, tools } = captureHost();
    registerReadTools(host, gql as never);
    const out = parseOut(await tools.get_ticket({ ticket: 'KDO-34' }));
    expect(out.comments).toHaveLength(10);
    expect(out.comments[0].comment).toBe('KDO-34-8');
    expect(out.earlierComments).toBe(7);
  });

  it('fetches the board and the comments in parallel, not in series', async () => {
    const { gql, log } = ticketGql([comment(1)]);
    const { host, tools } = captureHost();
    registerReadTools(host, gql as never);
    await tools.get_ticket({ ticket: 'KDO-34' });
    // The resolve must finish first — it produces the ids the other two need.
    expect(log.slice(0, 2)).toEqual(['resolve:start', 'resolve:end']);
    // The overlap: comments is in flight before the board read comes back.
    // Serial execution would log board:end before comments:start.
    expect(log.indexOf('comments:start')).toBeLessThan(log.indexOf('board:end'));
  });
});

describe('get_ticket dependencies', () => {
  const boardWithBlockers = {
    getBoard: {
      board: {
        key: 'KDO',
        columns: [
          { id: 'c1', label: 'Open', order: 0 },
          { id: 'c2', label: 'Done', order: 1 },
        ],
      },
      tags: [],
      releases: [],
      members: [],
      stories: [
        { id: 's1', num: 1, title: 'Blocked one', body: 'B', columnId: 'c1', tags: [], blockedBy: ['s2', 's3'], subtasks: [] },
        { id: 's2', num: 2, title: 'Open blocker', columnId: 'c1', tags: [], blockedBy: [], subtasks: [] },
        { id: 's3', num: 3, title: 'Done blocker', columnId: 'c2', tags: [], blockedBy: [], subtasks: [] },
      ],
    },
  };

  const stubFor = (bc: any) =>
    vi.fn(async (query: string) => {
      if (query.includes('resolveTicket')) {
        return { resolveTicket: { boardId: 'b1', storyId: 's1', subtaskId: null, archived: false } };
      }
      if (query.includes('comments')) return { comments: [] };
      return bc;
    });

  it('lists both blockers and flags the ticket blocked while one is open', async () => {
    const { host, tools } = captureHost();
    registerReadTools(host, stubFor(boardWithBlockers) as never);
    const out = JSON.parse((await tools.get_ticket({ ticket: 'KDO-1' })).content[0].text);
    expect(out.blockedBy).toEqual(['KDO-2', 'KDO-3']);
    expect(out.blocked).toBe(true);
  });

  it('drops the flag once every blocker is Done', async () => {
    const done = structuredClone(boardWithBlockers);
    done.getBoard.stories[1].columnId = 'c2';
    const { host, tools } = captureHost();
    registerReadTools(host, stubFor(done) as never);
    const out = JSON.parse((await tools.get_ticket({ ticket: 'KDO-1' })).content[0].text);
    expect(out.blockedBy).toEqual(['KDO-2', 'KDO-3']);
    expect(out).not.toHaveProperty('blocked');
  });
});

describe('list_archived is retired', () => {
  it('is no longer registered — search_tickets archived:"archived" answers it', () => {
    const { host, tools } = captureHost();
    registerReadTools(host, (async () => ({})) as never);
    expect(tools.list_archived).toBeUndefined();
    expect(tools.search_tickets).toBeDefined();
  });
});
