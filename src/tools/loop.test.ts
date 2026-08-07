import { describe, it, expect, vi } from 'vitest';
import { pickTagColors, registerLoopTools, UNBLOCKING_TAGS } from './loop.js';
import { KandoError } from '../graphql.js';
import type { ToolHost } from './read.js';

function capture() {
  const tools: Record<string, (args: any) => Promise<any>> = {};
  const configs: Record<string, any> = {};
  const host: ToolHost = {
    registerTool(name, c, cb) {
      tools[name] = cb;
      configs[name] = c;
      return undefined;
    },
  };
  return { host, tools, configs };
}

describe('pickTagColors', () => {
  it('gives claude orange and human-needed pink, else slate', () => {
    expect(pickTagColors('claude')).toEqual({ colorBg: '#FFF1E0', colorText: '#B76E00' });
    expect(pickTagColors('Human-Needed')).toEqual({ colorBg: '#FCE7F3', colorText: '#BE185D' });
    expect(pickTagColors('refined')).toEqual({ colorBg: '#E3F6EA', colorText: '#1F845A' });
    expect(pickTagColors('whatever')).toEqual({ colorBg: '#EEF0F2', colorText: '#5C6B7A' });
  });
});

describe('ensure_tag', () => {
  it('returns the existing tag id when the tag already exists (no create)', async () => {
    const gql = vi.fn(async (q: string) => {
      if (q.includes('myBoards')) return { myBoards: [{ id: 'b1', key: 'TSK' }] };
      if (q.includes('getBoard')) return { getBoard: { tags: [{ id: 't-claude', name: 'claude' }] } };
      throw new Error('unexpected op');
    });
    const { host, tools } = capture();
    registerLoopTools(host, gql as never);
    const res = JSON.parse((await tools.ensure_tag({ board: 'TSK', name: 'claude' })).content[0].text);
    // Acks by NAME: callers apply tags by name now, so an id would be dead weight.
    expect(res).toEqual({ tag: 'claude', created: false });
    expect(gql).not.toHaveBeenCalledWith(expect.stringContaining('createTag'), expect.anything());
  });

  it('creates the tag with the mapped colors when missing', async () => {
    const gql = vi.fn(async (q: string) => {
      if (q.includes('myBoards')) return { myBoards: [{ id: 'b1', key: 'TSK' }] };
      if (q.includes('getBoard')) return { getBoard: { tags: [] } };
      if (q.includes('createTag')) return { createTag: { tag: { id: 't-new', name: 'human-needed' } } };
      throw new Error('unexpected op');
    });
    const { host, tools } = capture();
    registerLoopTools(host, gql as never);
    const res = JSON.parse((await tools.ensure_tag({ board: 'TSK', name: 'human-needed' })).content[0].text);
    expect(res).toEqual({ tag: 'human-needed', created: true });
    expect(gql).toHaveBeenCalledWith(expect.stringContaining('createTag'), {
      boardId: 'b1',
      name: 'human-needed',
      colorBg: '#FCE7F3',
      colorText: '#BE185D',
    });
  });
});


describe('next_task description', () => {
  it('tells the caller that a started container is drained before standalone stories', () => {
    const { host, configs } = capture();
    registerLoopTools(host, (async () => ({})) as never);
    const d: string = configs.next_task.description;
    // All three tiers must be named, in order — this string is what Claude reads at runtime.
    expect(d).toMatch(/started/i);
    expect(d).toMatch(/untouched/i);
    const started = d.search(/started container/i);
    const standalone = d.search(/standalone stories/i);
    const untouched = d.search(/untouched container/i);
    expect(started).toBeGreaterThan(-1);
    expect(standalone).toBeGreaterThan(started);
    expect(untouched).toBeGreaterThan(standalone);
  });

  it('names every exclusion it applies, pending-ship included', () => {
    // The skip list is the description's contract. Omitting pending-ship leaves a
    // caller unable to explain why a ticket it can see is never handed back.
    const { host, configs } = capture();
    registerLoopTools(host, (async () => ({})) as never);
    const d: string = configs.next_task.description;
    for (const skipped of ['Done', 'snoozed', 'human-needed', 'pending-ship']) {
      expect(d).toContain(skipped);
    }
  });

  it('explains that pending-ship no longer blocks dependents, so a subtask and its dependent batch together', () => {
    const { host, configs } = capture();
    registerLoopTools(host, (async () => ({})) as never);
    const d: string = configs.next_task.description;
    expect(d).toMatch(/pending-ship.{0,200}(no longer|not).{0,40}block/is);
  });
});

describe('UNBLOCKING_TAGS', () => {
  it('is exactly pending-ship — human-needed marks a real stall, not finished work, so it must never unblock', () => {
    expect(UNBLOCKING_TAGS).toEqual(['pending-ship']);
    expect(UNBLOCKING_TAGS).not.toContain('human-needed');
  });
});

describe('next_task', () => {
  const entry = {
    ticket: 'TSK-6',
    kind: 'SUBTASK',
    id: 'sub1',
    storyId: 's5',
    columnId: 'c1',
    title: 'E-1',
  };

  const stub = (data: any) => {
    const calls: Array<{ query: string; variables: any }> = [];
    const gql = vi.fn(async (query: string, variables: any) => {
      calls.push({ query, variables });
      return data;
    });
    return { calls, gql };
  };

  it("asks the server, passing the target and the loop's own exclude tags", async () => {
    const { calls, gql } = stub({ nextTask: [entry] });
    const { host, tools } = capture();
    registerLoopTools(host, gql as never);

    await tools.next_task({ target: 'TSK' });

    expect(calls).toHaveLength(1);
    expect(calls[0].query).toContain('nextTask');
    expect(calls[0].variables).toEqual({
      target: 'TSK',
      excludeTags: ['human-needed', 'pending-ship'],
      unblockingTags: ['pending-ship'],
    });
  });

  it('returns the first entry with kind lowercased — the contract the loop reads', async () => {
    const { gql } = stub({ nextTask: [entry] });
    const { host, tools } = capture();
    registerLoopTools(host, gql as never);

    const out = JSON.parse((await tools.next_task({ target: 'TSK-5' })).content[0].text);
    expect(out).toEqual({
      ticket: 'TSK-6',
      kind: 'subtask',
      id: 'sub1',
      storyId: 's5',
      columnId: 'c1',
      title: 'E-1',
    });
  });

  it('omits storyId for a standalone story', async () => {
    const { gql } = stub({
      nextTask: [{ ticket: 'TSK-1', kind: 'STORY', id: 's1', storyId: null, columnId: 'c1', title: 'A' }],
    });
    const { host, tools } = capture();
    registerLoopTools(host, gql as never);

    const out = JSON.parse((await tools.next_task({ target: 'TSK' })).content[0].text);
    expect(out.kind).toBe('story');
    expect(out).not.toHaveProperty('storyId');
  });

  it('an empty list is {none:true} — nothing workable in that target', async () => {
    const { gql } = stub({ nextTask: [] });
    const { host, tools } = capture();
    registerLoopTools(host, gql as never);

    const out = JSON.parse((await tools.next_task({ target: 'TSK' })).content[0].text);
    expect(out).toEqual({ none: true });
  });

  it('re-raises BAD_INPUT with a read-shaped message naming both causes', async () => {
    const gql = vi.fn(async () => {
      throw new KandoError("That didn't save — a value isn't valid.", 'BAD_INPUT');
    });
    const { host, tools } = capture();
    registerLoopTools(host, gql as never);

    // The server cannot say WHICH, so the message names both — still far more
    // useful than the write-shaped generic ("the change was not saved").
    await expect(tools.next_task({ target: 'TSK-9' })).rejects.toThrow(/archived|board key/i);
    await expect(tools.next_task({ target: 'TSK-9' })).rejects.not.toThrow(/didn't save/i);
  });

  it('lets any other error through untouched', async () => {
    const gql = vi.fn(async () => {
      throw new KandoError('The bot lacks permission on this board.', 'UNAUTHORIZED');
    });
    const { host, tools } = capture();
    registerLoopTools(host, gql as never);
    await expect(tools.next_task({ target: 'TSK' })).rejects.toThrow(/permission/i);
  });
});
