import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerImageTools } from './images.js';
import { KandoError, mapErrorToken } from '../graphql.js';
import type { ToolHost } from './read.js';

const BOARD = '3f2b8c1e-5a47-4d0e-9a1b-0c2d3e4f5a6b';
const HOST = 'cdn.example.test';

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

/** CloudFront base64: + -> -, = -> _, / -> ~ */
const cfEncode = (s: string) =>
  Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/=/g, '_').replace(/\//g, '~');
const policyFor = (host = HOST, board = BOARD) =>
  cfEncode(
    JSON.stringify({ Statement: [{ Resource: `https://${host}/attachments/${board}/*` }] }),
  );

function accessGql(opts: { expiresAt?: string; policy?: string } = {}) {
  const calls: Array<{ q: string; v: any }> = [];
  const gql = async (q: string, v: any = {}) => {
    calls.push({ q, v });
    if (q.includes('attachmentAccess')) {
      return {
        attachmentAccess: {
          policy: opts.policy ?? policyFor(),
          signature: 'SIG',
          keyPairId: 'KPID',
          expiresAt: opts.expiresAt ?? new Date(Date.now() + 3600_000).toISOString(),
        },
      };
    }
    throw new Error(`unexpected query: ${q}`);
  };
  return { gql, calls };
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

function fakeFetch(res: { status?: number; body?: Buffer; type?: string } = {}) {
  const calls: Array<{ url: string; init: any }> = [];
  const f = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    const status = res.status ?? 200;
    return new Response(status === 200 ? new Uint8Array(res.body ?? PNG) : status === 204 ? null : 'x', {
      status,
      headers: { 'Content-Type': res.type ?? 'image/png' },
    });
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe('get_image', () => {
  it('returns one image block with the served bytes and mimeType', async () => {
    const { host, tools } = captureHost();
    const { gql } = accessGql();
    const { f } = fakeFetch({ body: PNG, type: 'image/png' });
    registerImageTools(host, gql, { fetch: f });
    const res = await tools.get_image({ src: `/attachments/${BOARD}/abc123` });
    expect(res.content).toHaveLength(1);
    expect(res.content[0].type).toBe('image');
    expect(res.content[0].mimeType).toBe('image/png');
    expect(Buffer.from(res.content[0].data, 'base64').equals(PNG)).toBe(true);
  });

  it('fetches from the policy host with all three CloudFront cookies', async () => {
    const { host, tools } = captureHost();
    const { gql, calls: gcalls } = accessGql();
    const { f, calls } = fakeFetch();
    registerImageTools(host, gql, { fetch: f });
    await tools.get_image({ src: `/attachments/${BOARD}/abc123` });
    expect(gcalls[0].v).toEqual({ boardId: BOARD });
    expect(calls[0].url).toBe(`https://${HOST}/attachments/${BOARD}/abc123`);
    expect(calls[0].init.headers.Cookie).toBe(
      'CloudFront-Policy=' + policyFor() + '; CloudFront-Signature=SIG; CloudFront-Key-Pair-Id=KPID',
    );
  });

  it('accepts a full URL but fetches against the policy host, not the supplied one', async () => {
    const { host, tools } = captureHost();
    const { gql } = accessGql();
    const { f, calls } = fakeFetch();
    registerImageTools(host, gql, { fetch: f });
    await tools.get_image({ src: `https://other.example/attachments/${BOARD}/abc123` });
    expect(calls[0].url).toBe(`https://${HOST}/attachments/${BOARD}/abc123`);
  });

  it('caches access per board until expiry, then asks again', async () => {
    let now = 1_000_000;
    const { host, tools } = captureHost();
    const { gql, calls } = accessGql({ expiresAt: new Date(now + 3600_000).toISOString() });
    const { f } = fakeFetch();
    registerImageTools(host, gql, { fetch: f, now: () => now });
    await tools.get_image({ src: `/attachments/${BOARD}/a` });
    await tools.get_image({ src: `/attachments/${BOARD}/b` });
    expect(calls).toHaveLength(1);
    now += 3600_000 + 1;
    await tools.get_image({ src: `/attachments/${BOARD}/c` });
    expect(calls).toHaveLength(2);
  });

  it.each([
    'https://evil.example/x.png',
    '/avatars/abc/x.png',
    'javascript:alert(1)',
    `../attachments/${BOARD}/a`,
    `/attachments/${BOARD}/a/../b`,
    `http://x.example/attachments/${BOARD}/a`,
    `/attachments/${BOARD}/`,
  ])('rejects %s with BAD_INPUT and never fetches', async (src) => {
    const { host, tools } = captureHost();
    const { gql, calls } = accessGql();
    const { f, calls: fcalls } = fakeFetch();
    registerImageTools(host, gql, { fetch: f });
    await expect(tools.get_image({ src })).rejects.toMatchObject({ token: 'BAD_INPUT' });
    expect(calls).toHaveLength(0);
    expect(fcalls).toHaveLength(0);
  });

  it('gives distinct readable errors for 403, 404 and other statuses', async () => {
    const run = async (status: number) => {
      const { host, tools } = captureHost();
      const { gql } = accessGql();
      const { f } = fakeFetch({ status });
      registerImageTools(host, gql, { fetch: f });
      return tools.get_image({ src: `/attachments/${BOARD}/a` }).catch((e) => e as Error);
    };
    const e403 = await run(403);
    const e404 = await run(404);
    const e500 = await run(500);
    expect((e403 as Error).message).toMatch(/not a member|access denied/i);
    expect((e404 as Error).message).toMatch(/not found/i);
    expect((e500 as Error).message).toContain('500');
  });

  it('raises a KandoError when the policy cannot be parsed', async () => {
    const { host, tools } = captureHost();
    const { gql } = accessGql({ policy: 'not-a-policy' });
    const { f } = fakeFetch();
    registerImageTools(host, gql, { fetch: f });
    await expect(tools.get_image({ src: `/attachments/${BOARD}/a` })).rejects.toBeInstanceOf(
      KandoError,
    );
  });
});

describe('upload_image', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kando-img-'));
  const file = (name: string, data: Buffer) => {
    const p = join(dir, name);
    writeFileSync(p, data);
    return p;
  };

  function uploadGql(over: { fields?: string; confirmError?: string; presignError?: string } = {}) {
    const calls: Array<{ q: string; v: any }> = [];
    const gql = async (q: string, v: any = {}) => {
      calls.push({ q, v });
      if (q.includes('resolveTicket')) return { resolveTicket: { boardId: BOARD, subtaskId: 'sub1', storyId: 's1' } };
      if (q.includes('attachmentUploadUrl')) {
        if (over.presignError) throw new KandoError(mapErrorToken(over.presignError), over.presignError);
        return {
          attachmentUploadUrl: {
            id: 'img1',
            url: 'https://s3.example.test/bucket',
            fields: over.fields ?? JSON.stringify({ key: 'k', policy: 'p' }),
          },
        };
      }
      if (q.includes('confirmAttachment')) {
        return { confirmAttachment: { id: 'img1', url: `/attachments/${BOARD}/img1` } };
      }
      throw new Error(`unexpected query: ${q}`);
    };
    return { gql, calls };
  }

  const setup = (over: Parameters<typeof uploadGql>[0] = {}, status = 204) => {
    const { host, tools, configs } = captureHost();
    const g = uploadGql(over);
    const ff = fakeFetch({ status });
    registerImageTools(host, g.gql, { fetch: ff.f });
    return { tools, configs, ...g, fcalls: ff.calls };
  };

  it('rejects non-image, svg, empty and oversized files with no GraphQL call', async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]);
    const cases = [
      file('a.txt', Buffer.from('hello world')),
      file('a.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')),
      file('empty.png', Buffer.alloc(0)),
      file('big.png', big),
      join(dir, 'missing.png'),
    ];
    for (const path of cases) {
      const s = setup();
      await expect(s.tools.upload_image({ board: BOARD, path })).rejects.toMatchObject({
        token: 'BAD_INPUT',
      });
      expect(s.calls).toHaveLength(0);
      expect(s.fcalls).toHaveLength(0);
    }
  });

  it('posts presigned fields (double-encoded ok) before file, confirms, returns markdown', async () => {
    const inner = JSON.stringify({ key: 'k', policy: 'p' });
    const s = setup({ fields: JSON.stringify(inner) });
    const res = await s.tools.upload_image({ board: BOARD, path: file('shot.png', PNG) });
    expect(s.fcalls).toHaveLength(1);
    expect(s.fcalls[0].url).toBe('https://s3.example.test/bucket');
    expect(s.fcalls[0].init.method).toBe('POST');
    const form = s.fcalls[0].init.body as FormData;
    const keys = [...form.keys()];
    expect(keys).toEqual(['key', 'policy', 'file']);
    const sent = form.get('file') as Blob;
    expect(Buffer.from(await sent.arrayBuffer()).equals(PNG)).toBe(true);
    expect(s.calls.map((c) => c.q.match(/attachmentUploadUrl|confirmAttachment/)?.[0])).toEqual([
      'attachmentUploadUrl',
      'confirmAttachment',
    ]);
    expect(s.calls[1].v).toEqual({ boardId: BOARD, attachmentId: 'img1' });
    expect(JSON.parse(res.content[0].text)).toEqual({
      markdown: `![shot.png](/attachments/${BOARD}/img1)`,
      url: `/attachments/${BOARD}/img1`,
      id: 'img1',
    });
  });

  it('uses alt when given', async () => {
    const s = setup();
    const res = await s.tools.upload_image({ board: BOARD, path: file('x.png', PNG), alt: 'evidence' });
    expect(JSON.parse(res.content[0].text).markdown).toBe(`![evidence](/attachments/${BOARD}/img1)`);
  });

  it('binds to the ticket item id when ticket is given, null otherwise', async () => {
    const s = setup();
    await s.tools.upload_image({ board: BOARD, path: file('t.png', PNG), ticket: 'KDO-5' });
    const withTicket = s.calls.find((c) => c.q.includes('attachmentUploadUrl'))!;
    expect(withTicket.v).toMatchObject({ boardId: BOARD, itemId: 'sub1', contentType: 'image/png' });

    const s2 = setup();
    await s2.tools.upload_image({ board: BOARD, path: file('t2.png', PNG) });
    const without = s2.calls.find((c) => c.q.includes('attachmentUploadUrl'))!;
    expect(without.v.itemId).toBeNull();
  });

  it('detects jpeg, gif and webp from magic bytes', async () => {
    const samples: Array<[Buffer, string]> = [
      [Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]), 'image/jpeg'],
      [Buffer.from('GIF89a....'), 'image/gif'],
      [Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 0, 0, 0]), Buffer.from('WEBPVP8 ')]), 'image/webp'],
    ];
    for (const [buf, type] of samples) {
      const s = setup();
      await s.tools.upload_image({ board: BOARD, path: file('i.bin', buf) });
      expect(s.calls.find((c) => c.q.includes('attachmentUploadUrl'))!.v.contentType).toBe(type);
    }
  });

  it('surfaces a failed S3 POST with its status and never confirms', async () => {
    const s = setup({}, 403);
    await expect(
      s.tools.upload_image({ board: BOARD, path: file('f.png', PNG) }),
    ).rejects.toThrow(/403/);
    expect(s.calls.some((c) => c.q.includes('confirmAttachment'))).toBe(false);
  });

  it('surfaces IMAGE_QUOTA_EXCEEDED as a readable error', async () => {
    const s = setup({ presignError: 'IMAGE_QUOTA_EXCEEDED' });
    await expect(
      s.tools.upload_image({ board: BOARD, path: file('q.png', PNG) }),
    ).rejects.toThrow(/quota/i);
  });

  it('describes the binding behaviour', () => {
    const s = setup();
    expect(s.configs.upload_image.description).toMatch(/24h/);
  });
});

describe('error mapping', () => {
  it('maps IMAGE_QUOTA_EXCEEDED and FORBIDDEN', () => {
    expect(mapErrorToken('IMAGE_QUOTA_EXCEEDED')).toMatch(/quota/i);
    expect(mapErrorToken('FORBIDDEN')).not.toMatch(/went wrong/);
  });
});
