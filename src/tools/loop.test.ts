import { describe, it, expect, vi } from 'vitest';
import { pickTagColors, registerLoopTools, selectNextTask } from './loop.js';
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
    registerLoopTools(host, gql as never, 'claude@nientiedt.de');
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
    registerLoopTools(host, gql as never, 'claude@nientiedt.de');
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

const board = {
  board: {
    key: 'TSK',
    columns: [
      { id: 'c1', label: 'To Do', order: 0 },
      { id: 'c2', label: 'Doing', order: 1 },
      { id: 'c3', label: 'Done', order: 2 },
    ],
  },
  tags: [{ id: 't-hn', name: 'human-needed' }],
  members: [
    { userSub: 'bot', email: 'claude@nientiedt.de' },
    { userSub: 'human', email: 'p@x.de' },
  ],
  stories: [
    { id: 's1', num: 1, title: 'A', columnId: 'c1', rank: 'a', tags: [], assignee: null, visibleAt: null, subtasks: [] },
    { id: 's2', num: 2, title: 'B', columnId: 'c3', rank: 'a', tags: [], assignee: null, visibleAt: null, subtasks: [] },
    { id: 's3', num: 3, title: 'C', columnId: 'c1', rank: 'b', tags: [], assignee: 'human', visibleAt: null, subtasks: [] },
    { id: 's4', num: 4, title: 'D', columnId: 'c1', rank: 'c', tags: ['t-hn'], assignee: null, visibleAt: null, subtasks: [] },
    // s5's only subtask sits in the FIRST column, so s5 is an UNTOUCHED container
    // (KDO-45): tier 1 is empty and the general standalone-first rule applies.
    {
      id: 's5', num: 5, title: 'E', columnId: 'c1', rank: 'd', tags: [], assignee: null, visibleAt: null,
      subtasks: [{ id: 'sub1', num: 6, title: 'E-1', columnId: 'c1', rank: 'a', tags: [], assignee: 'bot', visibleAt: null }],
    },
  ],
};

describe('selectNextTask', () => {
  it('board scope: standalone stories come before container swimlanes; skips done/human/human-needed', () => {
    // s1 is a standalone story (TSK-1); s5 is a container (its subtask TSK-6 is a
    // workable swimlane unit). Standalone stories are worked first, so TSK-1 is
    // picked before TSK-6 (s2/s3/s4 are skipped: done / human-assigned / human-needed).
    const next = selectNextTask(board, { kind: 'board' }, 'bot');
    expect(next?.ticket).toBe('TSK-1');
  });

  it('respects assignee (unassigned or bot only)', () => {
    const onlyHuman = { ...board, stories: [board.stories[2]] };
    expect(selectNextTask(onlyHuman, { kind: 'board' }, 'bot')).toBeNull();
  });

  it('story scope on a container returns its workable subtask', () => {
    const next = selectNextTask(board, { kind: 'story', storyId: 's5' }, 'bot');
    expect(next?.ticket).toBe('TSK-6');
    expect(next?.kind).toBe('subtask');
    expect(next?.storyId).toBe('s5');
  });

  it('returns null when nothing is workable', () => {
    const doneBoard = { ...board, stories: [board.stories[1]] };
    expect(selectNextTask(doneBoard, { kind: 'board' }, 'bot')).toBeNull();
  });

  it('skips a snoozed unit', () => {
    const snoozed = { ...board, stories: [{ ...board.stories[0], visibleAt: '2999-01-01T00:00:00Z' }] };
    expect(selectNextTask(snoozed, { kind: 'board' }, 'bot')).toBeNull();
  });

  it('skips a pending-ship unit — work parked on the loop branch is not re-served', () => {
    // TSK-1 is the normal pick. Tagged pending-ship it is finished-but-unshipped:
    // still in an in-progress column, still assigned to the bot, and NOT workable.
    const held = {
      ...board,
      tags: [...board.tags, { id: 't-ps', name: 'pending-ship' }],
      stories: [{ ...board.stories[0], tags: ['t-ps'] }],
    };
    expect(selectNextTask(held, { kind: 'board' }, 'bot')).toBeNull();
  });

  it('matches the pending-ship tag case-insensitively, like human-needed', () => {
    const held = {
      ...board,
      tags: [...board.tags, { id: 't-ps', name: 'Pending-Ship' }],
      stories: [{ ...board.stories[0], tags: ['t-ps'] }],
    };
    expect(selectNextTask(held, { kind: 'board' }, 'bot')).toBeNull();
  });

  it('serves the ticket again once pending-ship is cleared', () => {
    const released = {
      ...board,
      tags: [...board.tags, { id: 't-ps', name: 'pending-ship' }],
      stories: [{ ...board.stories[0], tags: [] }],
    };
    expect(selectNextTask(released, { kind: 'board' }, 'bot')?.ticket).toBe('TSK-1');
  });

  it('is unaffected on a board that has no pending-ship tag', () => {
    // The tag is optional: a board that never defined it behaves exactly as before.
    expect(selectNextTask(board, { kind: 'board' }, 'bot')?.ticket).toBe('TSK-1');
  });

  it('WITHIN a tier follows board order (lane rank) — column stage is NOT a priority', () => {
    // Both lanes are STARTED containers (each has a Done subtask), so they sit in the
    // same tier and only lane rank can separate them. Their workable subtasks sit in
    // DIFFERENT columns — the top lane's in the LATER one — so if column stage were a
    // priority the lower lane would win.
    const lane = (id: string, num: number, rank: string, workable: { id: string; num: number; columnId: string }) => ({
      id, num, title: id, columnId: 'todo', rank, tags: [], assignee: null, visibleAt: null,
      subtasks: [
        { id: `${id}-w`, num: workable.num, title: 'W', columnId: workable.columnId, rank: 'a', tags: [], assignee: null, visibleAt: null },
        // the Done subtask that makes this container "started"
        { id: `${id}-d`, num: num * 100, title: 'D', columnId: 'done', rank: 'b', tags: [], assignee: null, visibleAt: null },
      ],
    });
    const A = lane('A', 1, 'a', { id: 'x', num: 10, columnId: 'doing' }); // top lane, LATER column
    const B = lane('B', 2, 'b', { id: 'y', num: 11, columnId: 'todo' }); // lower lane, FIRST column
    const mkBoard = (stories: any[]) => ({
      board: {
        key: 'TSK',
        columns: [
          { id: 'todo', label: 'To Do', order: 0 },
          { id: 'doing', label: 'Doing', order: 1 },
          { id: 'done', label: 'Done', order: 2 },
        ],
      },
      tags: [],
      members: [{ userSub: 'bot', email: 'bot@x' }],
      stories,
    });
    // The top lane's subtask wins even though it sits in a later column — UI order, no column priority.
    expect(selectNextTask(mkBoard([A, B]), { kind: 'board' }, 'bot')?.ticket).toBe('TSK-10');
    // Swap the lanes' rank order and the answer follows the rank, not the column stage.
    expect(selectNextTask(mkBoard([B, A]), { kind: 'board' }, 'bot')?.ticket).toBe('TSK-11');
  });
});

describe('selectNextTask — a STARTED container is drained before standalone stories (KDO-45)', () => {
  const columns = [
    { id: 'todo', label: 'To Do', order: 0 },
    { id: 'doing', label: 'Doing', order: 1 },
    { id: 'done', label: 'Done', order: 2 },
  ];
  const mk = (stories: any[]) => ({
    board: { key: 'TSK', columns },
    tags: [{ id: 't-hn', name: 'human-needed' }],
    members: [{ userSub: 'bot', email: 'claude@nientiedt.de' }],
    stories,
  });
  const st = (o: any) => ({ tags: [], assignee: null, visibleAt: null, subtasks: [], ...o });

  it('regression: a container with a Done + an Open subtask beats a standalone story', () => {
    // The reported scenario: the loop worked one subtask (it is now Done), and a
    // standalone story appeared meanwhile. The container must be finished first.
    // The standalone is FIRST in lane order, so array order cannot mask the tiering.
    const b = mk([
      st({ id: 'new', num: 1, title: 'new standalone', columnId: 'todo', rank: 'a' }),
      st({
        id: 'c', num: 2, title: 'container', columnId: 'todo', rank: 'b',
        subtasks: [
          st({ id: 'c-1', num: 3, title: 'done one', columnId: 'done', rank: 'a' }),
          st({ id: 'c-2', num: 4, title: 'open one', columnId: 'todo', rank: 'b' }),
        ],
      }),
    ]);
    expect(selectNextTask(b, { kind: 'board' }, 'bot')?.ticket).toBe('TSK-4');
  });

  it('several started containers drain in lane rank order before any standalone', () => {
    const b = mk([
      st({ id: 'new', num: 1, title: 'new standalone', columnId: 'todo', rank: 'a' }),
      st({
        id: 'c1', num: 2, title: 'container 1', columnId: 'todo', rank: 'b',
        subtasks: [
          st({ id: 'c1-1', num: 10, title: 'c1 done', columnId: 'done', rank: 'a' }),
          st({ id: 'c1-2', num: 11, title: 'c1 open', columnId: 'doing', rank: 'b' }),
        ],
      }),
      st({
        id: 'c2', num: 3, title: 'container 2', columnId: 'todo', rank: 'c',
        subtasks: [
          st({ id: 'c2-1', num: 20, title: 'c2 done', columnId: 'done', rank: 'a' }),
          st({ id: 'c2-2', num: 21, title: 'c2 open', columnId: 'todo', rank: 'b' }),
        ],
      }),
    ]);
    // Lane rank order within tier 1: container 1 first.
    expect(selectNextTask(b, { kind: 'board' }, 'bot')?.ticket).toBe('TSK-11');
    // Once container 1 is fully Done, the NEXT started container still outranks the standalone.
    const c1Done = JSON.parse(JSON.stringify(b));
    c1Done.stories[1].subtasks[1].columnId = 'done';
    expect(selectNextTask(c1Done, { kind: 'board' }, 'bot')?.ticket).toBe('TSK-21');
  });

  it('an all-Done container does not block a standalone story', () => {
    const b = mk([
      st({
        id: 'c', num: 1, title: 'finished container', columnId: 'todo', rank: 'a',
        subtasks: [
          st({ id: 'c-1', num: 2, title: 'done a', columnId: 'done', rank: 'a' }),
          st({ id: 'c-2', num: 3, title: 'done b', columnId: 'done', rank: 'b' }),
        ],
      }),
      st({ id: 'sa', num: 4, title: 'standalone', columnId: 'todo', rank: 'b' }),
    ]);
    expect(selectNextTask(b, { kind: 'board' }, 'bot')?.ticket).toBe('TSK-4');
  });

  it('a human-needed subtask past the first column still marks its container started', () => {
    const b = mk([
      st({ id: 'sa', num: 1, title: 'standalone', columnId: 'todo', rank: 'a' }),
      st({
        id: 'c', num: 2, title: 'container', columnId: 'todo', rank: 'b',
        subtasks: [
          st({ id: 'c-1', num: 3, title: 'blocked', columnId: 'doing', rank: 'a', tags: ['t-hn'] }),
          st({ id: 'c-2', num: 4, title: 'workable', columnId: 'todo', rank: 'b' }),
        ],
      }),
    ]);
    expect(selectNextTask(b, { kind: 'board' }, 'bot')?.ticket).toBe('TSK-4');
  });

  it('a tier-1 unit assigned to a human is skipped for the next started-container unit', () => {
    const b = mk([
      st({ id: 'sa', num: 1, title: 'standalone', columnId: 'todo', rank: 'a' }),
      st({
        id: 'c', num: 2, title: 'container', columnId: 'todo', rank: 'b',
        subtasks: [
          st({ id: 'c-1', num: 3, title: "a human's", columnId: 'doing', rank: 'a', assignee: 'someone-else' }),
          st({ id: 'c-2', num: 4, title: 'workable', columnId: 'todo', rank: 'b' }),
        ],
      }),
    ]);
    expect(selectNextTask(b, { kind: 'board' }, 'bot')?.ticket).toBe('TSK-4');
  });

  it('two untouched containers keep lane rank order in tier 3', () => {
    const untouched = (id: string, num: number, rank: string, subNum: number) =>
      st({
        id, num, title: id, columnId: 'todo', rank,
        subtasks: [st({ id: `${id}-1`, num: subNum, title: `${id} sub`, columnId: 'todo', rank: 'a' })],
      });
    const A = untouched('A', 1, 'a', 10);
    const B = untouched('B', 2, 'b', 11);
    expect(selectNextTask(mk([A, B]), { kind: 'board' }, 'bot')?.ticket).toBe('TSK-10');
    expect(selectNextTask(mk([B, A]), { kind: 'board' }, 'bot')?.ticket).toBe('TSK-11');
  });

  it('reads the first column by lowest `order`, not by array position', () => {
    // columns arrive shuffled: taking columns[0] would make 'done' the first column,
    // so the untouched container below would look STARTED and jump the standalone.
    const shuffled = {
      ...mk([
        st({
          id: 'c', num: 1, title: 'untouched container', columnId: 'todo', rank: 'a',
          subtasks: [st({ id: 'c-1', num: 2, title: 'not started', columnId: 'todo', rank: 'a' })],
        }),
        st({ id: 'sa', num: 3, title: 'standalone', columnId: 'todo', rank: 'b' }),
      ]),
      board: {
        key: 'TSK',
        columns: [
          { id: 'done', label: 'Done', order: 2 },
          { id: 'todo', label: 'To Do', order: 0 },
          { id: 'doing', label: 'Doing', order: 1 },
        ],
      },
    };
    expect(selectNextTask(shuffled, { kind: 'board' }, 'bot')?.ticket).toBe('TSK-3');
  });

  it('an UNTOUCHED container still comes after standalone stories', () => {
    const b = mk([
      st({
        id: 'c', num: 1, title: 'untouched container', columnId: 'todo', rank: 'a',
        subtasks: [st({ id: 'c-1', num: 2, title: 'not started', columnId: 'todo', rank: 'a' })],
      }),
      st({ id: 'sa', num: 3, title: 'standalone', columnId: 'todo', rank: 'b' }),
    ]);
    expect(selectNextTask(b, { kind: 'board' }, 'bot')?.ticket).toBe('TSK-3');
  });
});

describe('next_task description', () => {
  it('tells the caller that a started container is drained before standalone stories', () => {
    const { host, configs } = capture();
    registerLoopTools(host, (async () => ({})) as never, 'claude@nientiedt.de');
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
    registerLoopTools(host, (async () => ({})) as never, 'claude@nientiedt.de');
    const d: string = configs.next_task.description;
    for (const skipped of ['Done', 'snoozed', 'human-needed', 'pending-ship']) {
      expect(d).toContain(skipped);
    }
  });
});
