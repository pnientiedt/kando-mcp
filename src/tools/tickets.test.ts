import { describe, it, expect, vi } from 'vitest';
import { buildUpdateVars, registerTicketTools } from './tickets.js';
import type { ToolHost } from './read.js';

describe('buildUpdateVars', () => {
  it('a move sends only columnId (never rank or other fields)', () => {
    const { query, variables } = buildUpdateVars({ boardId: 'b1', storyId: 's1' }, { column: 'c2' });
    expect(query).toContain('updateStory');
    expect(variables).toEqual({ boardId: 'b1', storyId: 's1', columnId: 'c2' });
    expect(variables).not.toHaveProperty('rank');
    expect(variables).not.toHaveProperty('title');
  });

  it('routes to updateSubtask when the ref is a subtask', () => {
    const { query, variables } = buildUpdateVars(
      { boardId: 'b1', storyId: 's1', subtaskId: 'sub1' },
      { title: 'x' },
    );
    expect(query).toContain('updateSubtask');
    expect(variables).toMatchObject({ boardId: 'b1', storyId: 's1', subtaskId: 'sub1', title: 'x' });
  });

  it('passes empty-string clears through for assignee/release/snooze', () => {
    const { variables } = buildUpdateVars(
      { boardId: 'b1', storyId: 's1' },
      { assignee: '', releaseId: '', visibleAt: '' },
    );
    expect(variables.assignee).toBe('');
    expect(variables.releaseId).toBe('');
    expect(variables.visibleAt).toBe('');
  });

  it('omits fields that were not provided', () => {
    const { variables } = buildUpdateVars({ boardId: 'b1', storyId: 's1' }, { body: 'hi' });
    expect(Object.keys(variables).sort()).toEqual(['body', 'boardId', 'storyId'].sort());
  });

  it('a reorder sends ONLY rank — never a column, assignee, release or snooze', () => {
    const { query, variables } = buildUpdateVars({ boardId: 'b1', storyId: 's1' }, { rank: 'V' });
    expect(query).toContain('updateStory');
    expect(variables).toEqual({ boardId: 'b1', storyId: 's1', rank: 'V' });
  });

  it('a subtask reorder sends only rank plus the identifying keys', () => {
    const { query, variables } = buildUpdateVars(
      { boardId: 'b1', storyId: 's1', subtaskId: 'sub1' },
      { rank: 'V' },
    );
    expect(query).toContain('updateSubtask');
    expect(variables).toEqual({ boardId: 'b1', storyId: 's1', subtaskId: 'sub1', rank: 'V' });
  });
});

/** A capturing ToolHost: records each tool's callback by name. */
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

/** Two standalone stories in `open`: KDO-1 (rank 'b'), KDO-2 (rank 'd'). */
function boardPayload() {
  return {
    getBoard: {
      board: { id: 'b1', key: 'KDO', columns: [{ id: 'open', label: 'Open', order: 0 }] },
      stories: [
        { id: 's1', num: 1, columnId: 'open', rank: 'b', archivedAt: null, subtasks: [] },
        { id: 's2', num: 2, columnId: 'open', rank: 'd', archivedAt: null, subtasks: [] },
      ],
    },
  };
}

describe('reorder_ticket', () => {
  it('computes the rank from the board and sends a rank-only update', async () => {
    const calls: Array<{ query: string; variables: any }> = [];
    const gql = vi.fn(async (query: string, variables: any) => {
      calls.push({ query, variables });
      if (query.includes('resolveTicket')) {
        return { resolveTicket: { boardId: 'b1', storyId: 's2', subtaskId: null } };
      }
      if (query.includes('getBoard')) return boardPayload();
      return { updateStory: { story: { id: 's2', rank: 'I' } } };
    });
    const { host, tools } = captureHost();
    registerTicketTools(host, gql as never);

    await tools.reorder_ticket({ ticket: 'KDO-2', to: 'top' });

    const update = calls.find((c) => c.query.includes('updateStory'));
    expect(update).toBeDefined();
    expect(update!.variables).toEqual({ boardId: 'b1', storyId: 's2', rank: expect.any(String) });
    expect(update!.variables.rank < 'b').toBe(true);
  });

  it('is an error result when neither to/before/after is given', async () => {
    const gql = vi.fn(async () => ({}));
    const { host, tools } = captureHost();
    registerTicketTools(host, gql as never);

    await expect(tools.reorder_ticket({ ticket: 'KDO-2' })).rejects.toThrow(/exactly one/i);
  });
});

describe('create_story / create_subtask position', () => {
  it('create_story with a position follows the create with a rank-only update', async () => {
    const calls: Array<{ query: string; variables: any }> = [];
    const gql = vi.fn(async (query: string, variables: any) => {
      calls.push({ query, variables });
      if (query.includes('myBoards')) return { myBoards: [{ id: 'b1', key: 'KDO' }] };
      if (query.includes('createStory')) {
        return { createStory: { story: { id: 's3', num: 3, columnId: 'open', rank: 'z' } } };
      }
      if (query.includes('getBoard')) {
        const p = boardPayload();
        p.getBoard.stories.push({
          id: 's3',
          num: 3,
          columnId: 'open',
          rank: 'z',
          archivedAt: null,
          subtasks: [],
        });
        return p;
      }
      return { updateStory: { story: { id: 's3' } } };
    });
    const { host, tools } = captureHost();
    registerTicketTools(host, gql as never);

    await tools.create_story({ board: 'KDO', title: 'new', column: 'open', position: { to: 'top' } });

    const update = calls.find((c) => c.query.includes('updateStory'));
    expect(update).toBeDefined();
    expect(update!.variables).toEqual({ boardId: 'b1', storyId: 's3', rank: expect.any(String) });
    expect(update!.variables.rank < 'b').toBe(true);
  });

  it('create_story without a position issues no update at all', async () => {
    const calls: string[] = [];
    const gql = vi.fn(async (query: string) => {
      calls.push(query);
      if (query.includes('myBoards')) return { myBoards: [{ id: 'b1', key: 'KDO' }] };
      // A create now always reads the board: it resolves the column label and
      // needs the board key to name the new ticket in its ack.
      if (query.includes('getBoard')) return boardPayload();
      return { createStory: { story: { id: 's3', num: 3 } } };
    });
    const { host, tools } = captureHost();
    registerTicketTools(host, gql as never);

    await tools.create_story({ board: 'KDO', title: 'new', column: 'open' });

    expect(calls.some((q) => q.includes('updateStory'))).toBe(false);
  });

  it('create_subtask with a position ranks it among its parent subtasks', async () => {
    const calls: Array<{ query: string; variables: any }> = [];
    const gql = vi.fn(async (query: string, variables: any) => {
      calls.push({ query, variables });
      if (query.includes('resolveTicket')) {
        return { resolveTicket: { boardId: 'b1', storyId: 's1', subtaskId: null } };
      }
      if (query.includes('createSubtask')) {
        return { createSubtask: { subtask: { id: 'x2', num: 9, columnId: 'open', rank: 'z' } } };
      }
      if (query.includes('getBoard')) {
        const p = boardPayload();
        p.getBoard.stories[0].subtasks = [
          { id: 'x1', num: 8, storyId: 's1', columnId: 'open', rank: 'b', archivedAt: null },
          { id: 'x2', num: 9, storyId: 's1', columnId: 'open', rank: 'z', archivedAt: null },
        ] as never;
        return p;
      }
      return { updateSubtask: { subtask: { id: 'x2' } } };
    });
    const { host, tools } = captureHost();
    registerTicketTools(host, gql as never);

    await tools.create_subtask({ parent: 'KDO-1', title: 'sub', column: 'open', position: { to: 'top' } });

    const update = calls.find((c) => c.query.includes('updateSubtask'));
    expect(update).toBeDefined();
    expect(update!.variables).toEqual({
      boardId: 'b1',
      storyId: 's1',
      subtaskId: 'x2',
      rank: expect.any(String),
    });
    expect(update!.variables.rank < 'b').toBe(true);
  });
});

/** A board with two columns, one tag and one member — enough to resolve against. */
function fullBoard() {
  return {
    getBoard: {
      board: {
        id: 'b1',
        key: 'KDO',
        columns: [
          { id: 'open', label: 'Open', order: 0 },
          { id: 'wip', label: 'In Progress', order: 1 },
        ],
      },
      stories: [{ id: 's1', num: 54, columnId: 'open', rank: 'b', archivedAt: null, subtasks: [] }],
      tags: [{ id: 't1', name: 'refined' }],
      releases: [],
      members: [{ userSub: 'u1', email: 'bot@example.com', role: 'EDITOR' }],
    },
  };
}

const ticketGql = (calls: any[], extra: (q: string) => any = () => ({})) =>
  vi.fn(async (q: string, v: any) => {
    calls.push({ q, v });
    if (q.includes('resolveTicket')) {
      return { resolveTicket: { boardId: 'b1', storyId: 's1', subtaskId: null } };
    }
    if (q.includes('myBoards')) return { myBoards: [{ id: 'b1', key: 'KDO' }] };
    if (q.includes('getBoard')) return fullBoard();
    return extra(q);
  });

describe('mutations return an ack, not the object', () => {
  it('move_ticket accepts a column LABEL and acks with it', async () => {
    const calls: any[] = [];
    const gql = ticketGql(calls, () => ({ updateStory: { story: { id: 's1', num: 54 } } }));
    const { host, tools } = captureHost();
    registerTicketTools(host, gql as never, 'bot@example.com');

    const out = JSON.parse(
      (await tools.move_ticket({ ticket: 'KDO-54', column: 'In Progress' })).content[0].text,
    );
    expect(out).toEqual({ ticket: 'KDO-54', col: 'In Progress' });
    expect(calls.find((c) => c.q.includes('updateStory'))!.v).toEqual({
      boardId: 'b1',
      storyId: 's1',
      columnId: 'wip',
    });
  });

  it('update_ticket resolves tag names and "me", and acks with the changed fields', async () => {
    const calls: any[] = [];
    const gql = ticketGql(calls, () => ({ updateStory: { story: { id: 's1', num: 54 } } }));
    const { host, tools } = captureHost();
    registerTicketTools(host, gql as never, 'bot@example.com');

    const out = JSON.parse(
      (
        await tools.update_ticket({
          ticket: 'KDO-54',
          body: 'new',
          tags: ['refined'],
          assignee: 'me',
        })
      ).content[0].text,
    );
    expect(out).toEqual({ ticket: 'KDO-54', updated: ['body', 'tags', 'assignee'] });
    const v = calls.find((c) => c.q.includes('updateStory'))!.v;
    expect(v.tags).toEqual(['t1']);
    expect(v.assignee).toBe('u1');
  });

  it('an unknown tag name is an error naming ensure_tag', async () => {
    const calls: any[] = [];
    const gql = ticketGql(calls);
    const { host, tools } = captureHost();
    registerTicketTools(host, gql as never, null);
    await expect(tools.update_ticket({ ticket: 'KDO-54', tags: ['nope'] })).rejects.toThrow(
      /ensure_tag/,
    );
  });

  it('unarchive_ticket acks instead of echoing the story', async () => {
    const calls: any[] = [];
    const gql = ticketGql(calls, () => ({ unarchiveStory: { story: { id: 's1', num: 54 } } }));
    const { host, tools } = captureHost();
    registerTicketTools(host, gql as never, null);
    expect(
      JSON.parse((await tools.unarchive_ticket({ ticket: 'KDO-54' })).content[0].text),
    ).toEqual({ unarchived: 'KDO-54' });
  });

  it('reorder_ticket acks the position', async () => {
    const calls: any[] = [];
    const gql = ticketGql(calls, () => ({ updateStory: { story: { id: 's1', num: 54 } } }));
    const { host, tools } = captureHost();
    registerTicketTools(host, gql as never, null);
    expect(
      JSON.parse((await tools.reorder_ticket({ ticket: 'KDO-54', to: 'top' })).content[0].text),
    ).toEqual({ ticket: 'KDO-54', position: 'top' });
  });

  it('create_story acks with the new KEY-N and column label', async () => {
    const calls: any[] = [];
    const gql = ticketGql(calls, (q) =>
      q.includes('createStory') ? { createStory: { story: { id: 's9', num: 63 } } } : {},
    );
    const { host, tools } = captureHost();
    registerTicketTools(host, gql as never, null);
    const out = JSON.parse(
      (await tools.create_story({ board: 'KDO', title: 'New', column: 'In Progress' })).content[0]
        .text,
    );
    expect(out).toEqual({ ticket: 'KDO-63', title: 'New', col: 'In Progress' });
  });
});
