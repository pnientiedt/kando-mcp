import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadPublicConfig, loadCredentials } from './config.js';
import { srpTokenProvider } from './auth.js';
import { makeGqlClient, type GqlClient } from './graphql.js';
import { registerReadTools, type ToolHost } from './tools/read.js';
import { registerTicketTools } from './tools/tickets.js';

/**
 * Live smoke test against the deployed Kando API as the bot account.
 * Skipped unless KANDO_LIVE=1 and mcp/.env holds the bot credentials.
 * Run: KANDO_LIVE=1 npx vitest run src/live.e2e.test.ts
 *
 * Note: deleteBoard removes the board partition but NOT the global
 * BOARDKEY#<KEY> registry row (same gap the web e2e sweeps in its
 * global-teardown). Each run uses a random 8-letter key, so the orphaned
 * rows are harmless and never collide with real boards.
 */
const LIVE = process.env.KANDO_LIVE === '1';

const CREATE_BOARD = `
  mutation ($name: String!, $key: String!) {
    createBoard(name: $name, key: $key) { id key columns { id label order } }
  }`;
const DELETE_BOARD = `mutation ($boardId: ID!) { deleteBoard(boardId: $boardId) }`;

const randKey = () =>
  Array.from({ length: 8 }, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[Math.floor(Math.random() * 26)]).join('');

describe.skipIf(!LIVE)('live: bot drives create → move → archive', () => {
  let gql: GqlClient;
  let boardId = '';
  let boardKey = '';
  let lastColumnId = '';
  const tools: Record<string, (args: any) => Promise<any>> = {};

  beforeAll(async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const config = loadPublicConfig();
    const creds = loadCredentials(join(here, '..', '.env'));
    gql = makeGqlClient(config, srpTokenProvider(config, creds));

    const host: ToolHost = {
      registerTool(name, _c, cb) {
        tools[name] = cb;
        return undefined;
      },
    };
    registerReadTools(host, gql);
    registerTicketTools(host, gql);

    boardKey = randKey();
    const created = await gql(CREATE_BOARD, { name: `mcp-e2e ${boardKey}`, key: boardKey });
    boardId = created.createBoard.id;
    const cols = [...created.createBoard.columns].sort((a, b) => a.order - b.order);
    lastColumnId = cols[cols.length - 1].id;
  }, 30_000);

  afterAll(async () => {
    if (boardId) await gql(DELETE_BOARD, { boardId }).catch(() => {});
  });

  it('login works and the new board is listed', async () => {
    const res = await tools.list_boards({});
    const boards = JSON.parse(res.content[0].text);
    expect(boards.some((b: any) => b.key === boardKey)).toBe(true);
  });

  it('creates, moves, and archives a story via the tools', async () => {
    const createRes = await tools.create_story({ board: boardKey, title: 'e2e smoke' });
    const story = JSON.parse(createRes.content[0].text);
    expect(story.title).toBe('e2e smoke');
    const ticket = `${boardKey}-${story.num}`;

    // it shows up on the board
    const boardRes = await tools.get_board({ board: boardKey });
    const board = JSON.parse(boardRes.content[0].text);
    expect(board.items.some((i: any) => i.ticket === ticket)).toBe(true);

    // move to the last column
    const moveRes = await tools.move_ticket({ ticket, column: lastColumnId });
    const moved = JSON.parse(moveRes.content[0].text);
    expect(moved.columnId).toBe(lastColumnId);

    // archive it, then confirm it's in the archive and off the board
    await tools.archive_ticket({ ticket });
    const archRes = await tools.list_archived({ board: boardKey });
    const archived = JSON.parse(archRes.content[0].text);
    expect(archived.some((a: any) => a.story && a.story.num === story.num)).toBe(true);

    const afterRes = await tools.get_board({ board: boardKey });
    const after = JSON.parse(afterRes.content[0].text);
    expect(after.items.some((i: any) => i.ticket === ticket)).toBe(false);
  }, 30_000);
});
