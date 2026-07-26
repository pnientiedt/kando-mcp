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
      return { createStory: { story: { id: 's3' } } };
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
