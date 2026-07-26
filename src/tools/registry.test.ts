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
      return { createTag: { tag: { id: 't1' } } };
    });
    const { host, tools } = captureHost();
    registerRegistryTools(host, gql as never);

    const res = await tools.create_tag({ board: 'TSK', name: 'bug', colorBg: '#f00', colorText: '#fff' });
    expect(res.content[0].text).toContain('t1');
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
      return { createRelease: { release: { id: 'r1' } } };
    });
    const { host, tools } = captureHost();
    registerRegistryTools(host, gql as never);

    const res = await tools.create_release({ board: 'TSK', name: 'v1', targetDate: '2026-08-01' });
    expect(res.content[0].text).toContain('r1');
    expect(gql).toHaveBeenCalledWith(expect.stringContaining('createRelease'), {
      boardId: 'b1',
      name: 'v1',
      targetDate: '2026-08-01',
    });
  });
});
