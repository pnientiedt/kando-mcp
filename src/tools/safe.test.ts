import { describe, it, expect } from 'vitest';
import { bulletproofHost } from './safe.js';
import { KandoError } from '../graphql.js';
import type { ToolHost } from './read.js';

function capture() {
  const tools: Record<string, (args: any) => Promise<any>> = {};
  const host: ToolHost = {
    registerTool(name, _config, cb) {
      tools[name] = cb;
      return undefined;
    },
  };
  return { host, tools };
}

describe('bulletproofHost', () => {
  it('turns a thrown KandoError into an isError result (server keeps serving)', async () => {
    const { host, tools } = capture();
    bulletproofHost(host).registerTool('boom', {}, async () => {
      throw new KandoError('nope', 'BAD_INPUT');
    });
    const res = await tools.boom({});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('nope');
  });

  it('turns a non-Kando throw into an isError result too', async () => {
    const { host, tools } = capture();
    bulletproofHost(host).registerTool('boom', {}, async () => {
      throw new TypeError('undefined is not a function');
    });
    const res = await tools.boom({});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/not a function/);
  });

  it('passes a successful result through unchanged', async () => {
    const { host, tools } = capture();
    bulletproofHost(host).registerTool('ok', {}, async () => ({
      content: [{ type: 'text' as const, text: 'hi' }],
    }));
    const res = await tools.ok({});
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toBe('hi');
  });
});
