import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { srpTokenProvider } from './auth.js';
import { resolveLiveConfig } from './liveConfig.js';
import { makeGqlClient, type GqlClient } from './graphql.js';
import { registerReadTools, type ToolHost } from './tools/read.js';
import { registerTicketTools } from './tools/tickets.js';

/**
 * Live smoke test against a deployed Kando stage — intended to run against DEV,
 * never Prod (KDO-63). Config + credentials come entirely from the environment
 * via resolveLiveConfig, which refuses the Prod pool unless KANDO_ALLOW_PROD=1.
 * Skipped unless KANDO_LIVE=1.
 *
 *   KANDO_LIVE=1 \
 *   KANDO_TEST_REGION=eu-central-1 KANDO_TEST_POOL_ID=<dev pool> \
 *   KANDO_TEST_CLIENT_ID=<dev client> KANDO_TEST_GRAPHQL_URL=<dev graphql> \
 *   KANDO_TEST_EMAIL=<dev bot> KANDO_TEST_PASSWORD=<dev bot pw> \
 *   npx vitest run src/live.e2e.test.ts
 *
 * Cleanup deletes the board via deleteBoard, which since KDO-52 also frees the
 * global BOARDKEY#<KEY> registry row (best-effort) — so a run leaves nothing
 * behind. Each run uses a random 8-letter key.
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
    const { config, creds } = resolveLiveConfig();
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
    if (!boardId) return;
    // A failed delete strands the board *and* its BOARDKEY#<KEY> registry row —
    // exactly the orphan this cleanup exists to prevent. Fail loudly; a silent
    // catch here is how the existing Prod orphans went unnoticed.
    try {
      await gql(DELETE_BOARD, { boardId });
    } catch (err) {
      throw new Error(
        `live e2e LEAKED board ${boardKey} (${boardId}) — delete it and its ` +
          `BOARDKEY#${boardKey} row by hand. Cause: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
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
