import { z } from 'zod';
import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { KandoError } from '../graphql.js';
import { type Gql, type ToolHost, toolText, resolveBoardId } from './read.js';
import { resolveTicketRef } from '../tickets.js';
import { ATTACHMENT_ACCESS, ATTACHMENT_UPLOAD_URL, CONFIRM_ATTACHMENT } from '../operations.js';

const MAX_BYTES = 5 * 1024 * 1024;
/** Re-ask for cookies this long before they actually expire. */
const SAFETY_MS = 60_000;
const SRC_RE = /^\/attachments\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/;

const bad = (msg: string) => new KandoError(msg, 'BAD_INPUT');

export interface ImageDeps {
  fetch?: typeof fetch;
  now?: () => number;
}

/** Accept `/attachments/<board>/<id>` or the same path on an https URL; nothing else. */
export function parseImageSrc(src: string): { boardId: string; id: string; path: string } {
  let path = src;
  if (/^https:\/\//i.test(src)) {
    try {
      path = new URL(src).pathname;
    } catch {
      throw bad(`"${src}" is not a valid image URL.`);
    }
  }
  const m = path.match(SRC_RE);
  if (!m || m[2] === '.' || m[2] === '..') {
    throw bad(
      `"${src}" is not a Kando image. Expected /attachments/<boardId>/<id> as found in ticket markdown.`,
    );
  }
  return { boardId: m[1], id: m[2], path };
}

/** CloudFront base64 (-→+, _→=, ~→/), JSON, Statement[0].Resource = https://<host>/... */
export function hostFromPolicy(policy: string): string {
  try {
    const b64 = policy.replace(/-/g, '+').replace(/_/g, '=').replace(/~/g, '/');
    const json = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    const host = new URL(json.Statement[0].Resource.replace(/\*/g, 'x')).host;
    if (!host) throw new Error('empty host');
    return host;
  } catch {
    throw new KandoError('Could not read the image host from the signed policy.', 'BAD_POLICY');
  }
}

function sniff(buf: Buffer): string | null {
  const hex = (n: number) => buf.subarray(0, n);
  if (buf.length >= 8 && hex(8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buf.subarray(8, 12).toString('latin1') === 'WEBP'
  )
    return 'image/webp';
  return null;
}

/** AWSJSON may arrive double-encoded; unwrap until it is an object. */
function parseAwsJsonObject(raw: string): Record<string, string> {
  let v: unknown = raw;
  for (let i = 0; i < 3 && typeof v === 'string'; i++) v = JSON.parse(v);
  if (v === null || typeof v !== 'object') {
    throw new KandoError('The upload form from Kando was malformed.', 'UPLOAD_FAILED');
  }
  return v as Record<string, string>;
}

export function registerImageTools(server: ToolHost, gql: Gql, deps: ImageDeps = {}) {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const access = new Map<string, { cookie: string; host: string; until: number }>();

  async function accessFor(boardId: string) {
    const hit = access.get(boardId);
    if (hit && now() < hit.until) return hit;
    const a = (await gql(ATTACHMENT_ACCESS, { boardId })).attachmentAccess;
    const entry = {
      host: hostFromPolicy(a.policy),
      cookie:
        `CloudFront-Policy=${a.policy}; CloudFront-Signature=${a.signature}; ` +
        `CloudFront-Key-Pair-Id=${a.keyPairId}`,
      until: new Date(a.expiresAt).getTime() - SAFETY_MS,
    };
    access.set(boardId, entry);
    return entry;
  }

  server.registerTool(
    'get_image',
    {
      description:
        'Look at an image embedded in a ticket or comment. Pass the `/attachments/<boardId>/<id>` ' +
        'path exactly as it appears in the markdown (a full https URL to it also works). ' +
        'Returns the image itself. Only Kando attachment paths are fetched.',
      inputSchema: {
        src: z.string().describe('/attachments/<boardId>/<id> as found in markdown'),
      },
    },
    async ({ src }) => {
      const { boardId, path } = parseImageSrc(src);
      const a = await accessFor(boardId);
      const res = await doFetch(`https://${a.host}${path}`, { headers: { Cookie: a.cookie } });
      if (res.status === 403) {
        throw new KandoError('Access denied: the bot is not a member of that board.', 'FORBIDDEN');
      }
      if (res.status === 404) {
        throw new KandoError('Image not found (it may have been deleted).', 'NOT_FOUND');
      }
      if (!res.ok) throw new KandoError(`Image fetch failed with HTTP ${res.status}.`);
      const data = Buffer.from(await res.arrayBuffer()).toString('base64');
      const mimeType = (res.headers.get('content-type') ?? 'application/octet-stream').split(';')[0].trim();
      return { content: [{ type: 'image' as const, data, mimeType }] };
    },
  );

  server.registerTool(
    'upload_image',
    {
      description:
        'Upload a local image (png/jpeg/gif/webp, 1 B – 5 MB) and get back a markdown snippet to ' +
        'put into a ticket body or comment yourself via update_ticket/create_story/add_comment. ' +
        'With `ticket`, the image is bound to that ticket (use this for comments too, since the ' +
        'thread hangs off the ticket). Without `ticket`, the backend binds it when a body ' +
        'referencing it is saved. An image left unbound is deleted after 24h.',
      inputSchema: {
        board: z.string().describe('board key or id'),
        path: z.string().describe('local file path'),
        ticket: z.string().optional().describe('ticket id, e.g. TSK-42'),
        alt: z.string().optional().describe('alt text; default the file name'),
      },
    },
    async ({ board, path, ticket, alt }) => {
      let buf: Buffer;
      try {
        const st = await stat(path);
        if (!st.isFile()) throw bad(`${path} is not a file.`);
        if (st.size > MAX_BYTES) throw bad(`${path} is larger than 5 MB.`);
        buf = await readFile(path);
      } catch (e) {
        if (e instanceof KandoError) throw e;
        throw bad(`Cannot read ${path}: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (buf.length === 0) throw bad(`${path} is empty.`);
      if (buf.length > MAX_BYTES) throw bad(`${path} is larger than 5 MB.`);
      const contentType = sniff(buf);
      if (!contentType) {
        throw bad(`${path} is not a png, jpeg, gif or webp image (SVG is not accepted).`);
      }

      const boardId = await resolveBoardId(gql, board);
      let itemId: string | null = null;
      if (ticket) {
        const ref = await resolveTicketRef(gql, ticket);
        if (ref.boardId !== boardId) throw bad(`${ticket} is not on board ${board}.`);
        itemId = ref.subtaskId ?? ref.storyId ?? null;
      }

      const p = (await gql(ATTACHMENT_UPLOAD_URL, { boardId, itemId, contentType })).attachmentUploadUrl;
      const form = new FormData();
      for (const [k, v] of Object.entries(parseAwsJsonObject(p.fields))) form.append(k, String(v));
      form.append('file', new Blob([new Uint8Array(buf)], { type: contentType }), basename(path));
      const up = await doFetch(p.url, { method: 'POST', body: form });
      if (!up.ok) {
        throw new KandoError(`Image upload to storage failed with HTTP ${up.status}.`, 'UPLOAD_FAILED');
      }
      const c = (await gql(CONFIRM_ATTACHMENT, { boardId, attachmentId: p.id })).confirmAttachment;
      return toolText({ markdown: `![${alt ?? basename(path)}](${c.url})`, url: c.url, id: p.id });
    },
  );
}
