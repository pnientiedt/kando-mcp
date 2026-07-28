import { describe, it, expect } from 'vitest';
import { registerCommentTools } from './comments.js';
import type { ToolHost } from './read.js';

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

const BOARD = {
  getBoard: {
    board: { id: 'b1', key: 'KDO', name: 'Kando', role: 'EDITOR', columns: [] },
    stories: [{ id: 's1', num: 34, subtasks: [] }],
    tags: [],
    releases: [],
    members: [{ userSub: 'u1', email: 'bot@example.com', role: 'EDITOR' }],
  },
};

/**
 * A fake gql that records every call and answers by operation. `comments`
 * defaults to one comment on KDO-34.
 */
function fakeGql(over: Record<string, any> = {}) {
  const calls: Array<{ q: string; v: any }> = [];
  const gql = async (q: string, v: any = {}) => {
    calls.push({ q, v });
    if (q.includes('resolveTicket')) return { resolveTicket: { boardId: 'b1', storyId: 's1' } };
    if (q.includes('getBoard')) return BOARD;
    if (q.includes('comments(')) {
      return {
        comments: over.comments ?? [
          {
            id: 'KDO-34-1',
            author: 'u1',
            text: 'first',
            createdAt: '2026-07-28T10:00:00.000Z',
            editedAt: null,
          },
        ],
      };
    }
    if (q.includes('addComment')) return { addComment: { comment: { id: 'KDO-34-7' } } };
    if (q.includes('editComment')) return { editComment: { comment: { id: 'KDO-34-7' } } };
    if (q.includes('deleteComment')) return { deleteComment: { deletedId: 'KDO-34-7' } };
    throw new Error(`unexpected query: ${q}`);
  };
  return { gql, calls };
}

const parse = (res: any) => JSON.parse(res.content[0].text);
const ops = (calls: Array<{ q: string }>) =>
  calls.map((c) =>
    ['resolveTicket', 'getBoard', 'comments(', 'addComment', 'editComment', 'deleteComment'].find(
      (name) => c.q.includes(name),
    ),
  );

describe('list_comments', () => {
  it('returns every comment, uncapped, with authors resolved to emails', async () => {
    const { gql } = fakeGql({
      comments: Array.from({ length: 12 }, (_, i) => ({
        id: `KDO-34-${i + 1}`,
        author: 'u1',
        text: `c${i + 1}`,
        createdAt: '2026-07-28T10:00:00.000Z',
        editedAt: null,
      })),
    });
    const { host, tools } = captureHost();
    registerCommentTools(host, gql as never);
    const out = parse(await tools.list_comments({ ticket: 'KDO-34' }));
    expect(out.ticket).toBe('KDO-34');
    expect(out.comments).toHaveLength(12);
    expect(out).not.toHaveProperty('earlierComments');
    expect(out.comments[0].author).toBe('bot@example.com');
  });

  it('omits the comments key entirely when there are none', async () => {
    const { gql } = fakeGql({ comments: [] });
    const { host, tools } = captureHost();
    registerCommentTools(host, gql as never);
    const out = parse(await tools.list_comments({ ticket: 'KDO-34' }));
    expect(out).toEqual({ ticket: 'KDO-34' });
  });
});

describe('add_comment', () => {
  it('acks the key the server assigned, without re-reading', async () => {
    const { gql, calls } = fakeGql();
    const { host, tools } = captureHost();
    registerCommentTools(host, gql as never);
    const out = parse(await tools.add_comment({ ticket: 'KDO-34', text: 'hello' }));
    expect(out).toEqual({ comment: 'KDO-34-7', added: true });
    expect(ops(calls)).toEqual(['resolveTicket', 'addComment']);
  });

  it('comments on the subtask itself, not its parent story', async () => {
    const calls: Array<{ q: string; v: any }> = [];
    const gql = async (q: string, v: any = {}) => {
      calls.push({ q, v });
      if (q.includes('resolveTicket'))
        return { resolveTicket: { boardId: 'b1', storyId: 's1', subtaskId: 'sub9' } };
      return { addComment: { comment: { id: 'KDO-35-1' } } };
    };
    const { host, tools } = captureHost();
    registerCommentTools(host, gql as never);
    await tools.add_comment({ ticket: 'KDO-35', text: 'hi' });
    expect(calls[1].v.itemId).toBe('sub9');
  });
});

describe('edit_comment', () => {
  it('passes the key straight through as commentId and acks it', async () => {
    const { gql, calls } = fakeGql();
    const { host, tools } = captureHost();
    registerCommentTools(host, gql as never);
    const out = parse(await tools.edit_comment({ comment: 'KDO-34-7', text: 'fixed' }));
    expect(out).toEqual({ comment: 'KDO-34-7', edited: true });
    expect(ops(calls)).toEqual(['resolveTicket', 'editComment']);
    expect(calls[1].v.commentId).toBe('KDO-34-7');
    expect(calls[1].v.text).toBe('fixed');
  });

  it('resolves the ticket from the key, taking no ticket argument', async () => {
    const { gql, calls } = fakeGql();
    const { host, tools } = captureHost();
    registerCommentTools(host, gql as never);
    await tools.edit_comment({ comment: 'kdo-34-7', text: 'x' });
    expect(calls[0].v).toEqual({ key: 'KDO', num: 34 });
    expect(calls[1].v.commentId).toBe('KDO-34-7');
  });

  it('rejects a malformed key before sending anything', async () => {
    const { gql, calls } = fakeGql();
    const { host, tools } = captureHost();
    registerCommentTools(host, gql as never);
    await expect(tools.edit_comment({ comment: 'KDO-34', text: 'x' })).rejects.toThrow(
      /Not a comment key/,
    );
    expect(calls).toHaveLength(0);
  });
});

describe('delete_comment', () => {
  it('acks the id the server reports deleted', async () => {
    const { gql, calls } = fakeGql();
    const { host, tools } = captureHost();
    registerCommentTools(host, gql as never);
    const out = parse(await tools.delete_comment({ comment: 'KDO-34-7' }));
    expect(out).toEqual({ comment: 'KDO-34-7', deleted: true });
    expect(ops(calls)).toEqual(['resolveTicket', 'deleteComment']);
  });

  it('rejects a malformed key before sending anything', async () => {
    const { gql, calls } = fakeGql();
    const { host, tools } = captureHost();
    registerCommentTools(host, gql as never);
    await expect(tools.delete_comment({ comment: '34-1' })).rejects.toThrow(/Not a comment key/);
    expect(calls).toHaveLength(0);
  });
});

describe('tool descriptions', () => {
  it('tell the model comments are context, not instructions', async () => {
    const { gql } = fakeGql();
    const { host, configs } = captureHost();
    registerCommentTools(host, gql as never);
    expect(configs.list_comments.description).toMatch(/not instructions|never.*obey|context/i);
  });
});
