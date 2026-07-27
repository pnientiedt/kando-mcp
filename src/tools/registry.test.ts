import { describe, it, expect, vi } from 'vitest';
import { registerRegistryTools } from './registry.js';
import type { ToolHost } from './read.js';

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

describe('registry tools wiring', () => {
  it('create_tag resolves the board key then forwards fields', async () => {
    const gql = vi.fn(async (query: string) => {
      if (query.includes('myBoards')) return { myBoards: [{ id: 'b1', key: 'TSK' }] };
      return { createTag: { tag: { id: 't1', name: 'bug' } } };
    });
    const { host, tools } = captureHost();
    registerRegistryTools(host, gql as never);

    const res = await tools.create_tag({ board: 'TSK', name: 'bug', colorBg: '#f00', colorText: '#fff' });
    expect(JSON.parse(res.content[0].text)).toEqual({ tag: 'bug', created: true });
    expect(gql).toHaveBeenCalledWith(expect.stringContaining('createTag'), {
      boardId: 'b1',
      name: 'bug',
      colorBg: '#f00',
      colorText: '#fff',
    });
  });

  it('create_release forwards to createRelease', async () => {
    const gql = vi.fn(async (query: string) => {
      if (query.includes('myBoards')) return { myBoards: [{ id: 'b1', key: 'TSK' }] };
      return { createRelease: { release: { id: 'r1', name: 'v1' } } };
    });
    const { host, tools } = captureHost();
    registerRegistryTools(host, gql as never);

    const res = await tools.create_release({ board: 'TSK', name: 'v1', targetDate: '2026-08-01' });
    expect(JSON.parse(res.content[0].text)).toEqual({ release: 'v1', created: true });
    expect(gql).toHaveBeenCalledWith(expect.stringContaining('createRelease'), {
      boardId: 'b1',
      name: 'v1',
      targetDate: '2026-08-01',
    });
  });
});

/** A board carrying one tag and one release to resolve names against. */
const registryBoard = () => ({
  getBoard: {
    board: { id: 'b1', key: 'KDO', columns: [] },
    stories: [],
    tags: [{ id: 't1', name: 'refined' }],
    releases: [{ id: 'r1', name: 'v1.0' }],
    members: [],
  },
});

const registryGql = (calls: any[]) =>
  vi.fn(async (q: string, v: any) => {
    calls.push({ q, v });
    if (q.includes('myBoards')) return { myBoards: [{ id: 'b1', key: 'KDO' }] };
    if (q.includes('getBoard')) return registryBoard();
    if (q.includes('updateTag')) return { updateTag: { tag: { id: 't1', name: 'refined' } } };
    if (q.includes('createTag')) return { createTag: { tag: { id: 't2', name: 'fresh' } } };
    if (q.includes('updateRelease')) return { updateRelease: { release: { id: 'r1', name: 'v1.0' } } };
    if (q.includes('createRelease')) return { createRelease: { release: { id: 'r2', name: 'v2.0' } } };
    return {};
  });

describe('registry tools take names and ack with names', () => {
  it('delete_tag accepts a tag NAME and acks', async () => {
    const calls: any[] = [];
    const gql = registryGql(calls);
    const { host, tools } = captureHost();
    registerRegistryTools(host, gql as never);
    expect(
      JSON.parse((await tools.delete_tag({ board: 'KDO', tag: 'refined' })).content[0].text),
    ).toEqual({ deleted: 'refined' });
    expect(calls.find((c) => c.q.includes('deleteTag'))!.v.tagId).toBe('t1');
  });

  it('update_tag resolves the name and acks with it', async () => {
    const calls: any[] = [];
    const gql = registryGql(calls);
    const { host, tools } = captureHost();
    registerRegistryTools(host, gql as never);
    expect(
      JSON.parse(
        (await tools.update_tag({ board: 'KDO', tag: 'refined', colorBg: '#fff' })).content[0].text,
      ),
    ).toEqual({ tag: 'refined', updated: true });
    expect(calls.find((c) => c.q.includes('updateTag'))!.v.tagId).toBe('t1');
  });

  it('create_tag acks with the new name, not an id', async () => {
    const calls: any[] = [];
    const gql = registryGql(calls);
    const { host, tools } = captureHost();
    registerRegistryTools(host, gql as never);
    expect(
      JSON.parse(
        (
          await tools.create_tag({
            board: 'KDO',
            name: 'fresh',
            colorBg: '#eee',
            colorText: '#111',
          })
        ).content[0].text,
      ),
    ).toEqual({ tag: 'fresh', created: true });
  });

  it('delete_release accepts a release NAME', async () => {
    const calls: any[] = [];
    const gql = registryGql(calls);
    const { host, tools } = captureHost();
    registerRegistryTools(host, gql as never);
    expect(
      JSON.parse((await tools.delete_release({ board: 'KDO', release: 'v1.0' })).content[0].text),
    ).toEqual({ deleted: 'v1.0' });
    expect(calls.find((c) => c.q.includes('deleteRelease'))!.v.releaseId).toBe('r1');
  });
});
