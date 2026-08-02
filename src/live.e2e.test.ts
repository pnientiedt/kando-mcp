import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { srpTokenProvider } from './auth.js';
import { resolveLiveConfig, PROD_POOL_ID } from './liveConfig.js';
import { makeGqlClient, type GqlClient } from './graphql.js';
import { registerReadTools, type ToolHost } from './tools/read.js';
import { registerTicketTools } from './tools/tickets.js';
import { registerCommentTools } from './tools/comments.js';

/**
 * Live smoke test against a deployed Kando stage. Targets DEV by default and
 * never Prod (KDO-63): resolveLiveConfig takes the stage from the committed
 * kando.config.dev.json, and refuses the Prod pool unless KANDO_ALLOW_PROD=1.
 * Credentials come from the environment or gitignored .env.test.local — see
 * .env.test.local.example. Skipped unless KANDO_LIVE=1:
 *
 *   KANDO_LIVE=1 npx vitest run src/live.e2e.test.ts
 *
 * Cleanup deletes the board via deleteBoard, which since KDO-52 also frees the
 * global BOARDKEY#<KEY> registry row — so a run leaves nothing behind. That is
 * asserted, not assumed: the last test deletes a board and re-creates one under
 * the same key, which only succeeds if the registry row was actually freed.
 * Each run uses a random 8-letter key.
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
  let targetPoolId = '';
  let boardId = '';
  let boardKey = '';
  let lastColumnLabel = '';
  const tools: Record<string, (args: any) => Promise<any>> = {};

  beforeAll(async () => {
    const { config, creds } = resolveLiveConfig();
    targetPoolId = config.userPoolId;
    gql = makeGqlClient(config, srpTokenProvider(config, creds));

    const host: ToolHost = {
      registerTool(name, _c, cb) {
        tools[name] = cb;
        return undefined;
      },
    };
    registerReadTools(host, gql);
    registerTicketTools(host, gql);
    registerCommentTools(host, gql);

    boardKey = randKey();
    const created = await gql(CREATE_BOARD, { name: `mcp-e2e ${boardKey}`, key: boardKey });
    boardId = created.createBoard.id;
    const cols = [...created.createBoard.columns].sort((a, b) => a.order - b.order);
    lastColumnLabel = cols[cols.length - 1].label;
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

  // Belt and braces: resolveLiveConfig already refuses Prod, but this run created
  // real boards — say out loud where they went.
  it('is pointed at a non-production stage', () => {
    expect(targetPoolId).not.toBe(PROD_POOL_ID);
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
    // v0.6.0 turned every mutation echo into an ack: create_story reports the
    // ticket KEY-N directly and no longer carries a raw `num`.
    const ticket: string = story.ticket;
    expect(ticket).toMatch(/^[A-Z]+-\d+$/);

    // it shows up on the board
    const boardRes = await tools.get_board({ board: boardKey });
    const board = JSON.parse(boardRes.content[0].text);
    expect(board.items.some((i: any) => i.ticket === ticket)).toBe(true);

    // move to the last column — the ack names the column by LABEL now, not id
    const moveRes = await tools.move_ticket({ ticket, column: lastColumnLabel });
    const moved = JSON.parse(moveRes.content[0].text);
    expect(moved).toEqual({ ticket, col: lastColumnLabel });

    // archive it, then confirm it's in the archive and off the board
    await tools.archive_ticket({ ticket });
    const archRes = await tools.search_tickets({ boards: [boardKey], archived: 'archived' });
    const archived = JSON.parse(archRes.content[0].text);
    expect(archived.tickets.some((a: any) => a.ticket === ticket)).toBe(true);
    expect(archived.tickets.find((a: any) => a.ticket === ticket).archivedAt).toBeTruthy();

    const afterRes = await tools.get_board({ board: boardKey });
    const after = JSON.parse(afterRes.content[0].text);
    expect(after.items.some((i: any) => i.ticket === ticket)).toBe(false);
  }, 30_000);

  /**
   * KDO-90/KDO-91's acceptance, end to end against the deployed backend — the one
   * claim a fake gql cannot make. Archiving through MCP used to be a one-way door:
   * `resolveTicket` 404'd archived tickets, so the tool that restores one could
   * never resolve its own target, and `get_ticket` answered "no longer exists" for
   * a ticket sitting in the archive intact.
   */
  it('reads and restores an archived ticket — the round trip that used to be impossible', async () => {
    const BODY = 'the body that must survive the round trip';
    const created = JSON.parse(
      (await tools.create_story({ board: boardKey, title: 'e2e archive round trip', body: BODY }))
        .content[0].text,
    );
    const ticket: string = created.ticket;
    await tools.archive_ticket({ ticket });

    // 1. get_ticket returns it, marked archived, with the body intact.
    const detail = JSON.parse((await tools.get_ticket({ ticket })).content[0].text);
    expect(detail).toMatchObject({ ticket, archived: true, body: BODY });
    expect(detail.archivedAt).toEqual(expect.any(String));

    // 2. A write is refused as archived — not reported as deleted.
    await expect(tools.update_ticket({ ticket, title: 'nope' })).rejects.toThrow(/archived/i);
    await expect(tools.update_ticket({ ticket, title: 'nope' })).rejects.not.toThrow(
      /no longer exists/i,
    );

    // 3. unarchive_ticket actually restores it, and it is back on the board.
    expect(
      JSON.parse((await tools.unarchive_ticket({ ticket })).content[0].text),
    ).toMatchObject({ unarchived: ticket });
    const board = JSON.parse((await tools.get_board({ board: boardKey })).content[0].text);
    expect(board.items.some((i: any) => i.ticket === ticket)).toBe(true);

    // 4. Live again: readable without the archived marker, and writable.
    const live = JSON.parse((await tools.get_ticket({ ticket })).content[0].text);
    expect(live.archived).toBeUndefined();
    expect(live.body).toBe(BODY);
    await expect(tools.unarchive_ticket({ ticket })).rejects.toThrow(/not archived/i);
  }, 30_000);

  // A genuinely absent ticket must still read as gone — the guard that keeps
  // "archived" from swallowing real NOT_FOUNDs.
  it('still reports a never-existing ticket as gone', async () => {
    await expect(tools.get_ticket({ ticket: `${boardKey}-9999` })).rejects.toThrow(
      /no longer exists/i,
    );
  }, 30_000);

  // The claim the whole comment-addressing design rests on: the per-item ordinal
  // is persisted and monotonic. A fake gql cannot prove that — only the backend
  // can — so it is asserted here rather than assumed. If a delete ever starts
  // renumbering, `edit_comment KEY-N-M` silently retargets and this test is what
  // catches it.
  it('adds, lists, edits and deletes comments — and never reuses an ordinal', async () => {
    const created = JSON.parse(
      (await tools.create_story({ board: boardKey, title: 'e2e comments' })).content[0].text,
    );
    const ticket: string = created.ticket;

    const first = JSON.parse((await tools.add_comment({ ticket, text: 'one' })).content[0].text);
    const second = JSON.parse((await tools.add_comment({ ticket, text: 'two' })).content[0].text);
    expect(first.comment).toBe(`${ticket}-1`);
    expect(second.comment).toBe(`${ticket}-2`);

    const listed = JSON.parse((await tools.list_comments({ ticket })).content[0].text);
    expect(listed.comments.map((c: any) => c.comment)).toEqual([`${ticket}-1`, `${ticket}-2`]);
    expect(listed.comments[0].text).toBe('one');

    const edited = JSON.parse(
      (await tools.edit_comment({ comment: first.comment, text: 'one edited' })).content[0].text,
    );
    expect(edited).toEqual({ comment: `${ticket}-1`, edited: true });

    const afterEdit = JSON.parse((await tools.list_comments({ ticket })).content[0].text);
    expect(afterEdit.comments[0].text).toBe('one edited');
    expect(afterEdit.comments[0].edited).toBe(true);

    // Deleting -1 must neither renumber -2 nor free the number 1 for reuse.
    await tools.delete_comment({ comment: first.comment });
    const third = JSON.parse((await tools.add_comment({ ticket, text: 'three' })).content[0].text);
    expect(third.comment).toBe(`${ticket}-3`);

    const final = JSON.parse((await tools.list_comments({ ticket })).content[0].text);
    expect(final.comments.map((c: any) => c.comment)).toEqual([`${ticket}-2`, `${ticket}-3`]);

    // get_ticket carries the same comments inline.
    const detail = JSON.parse((await tools.get_ticket({ ticket })).content[0].text);
    expect(detail.comments.map((c: any) => c.comment)).toEqual([`${ticket}-2`, `${ticket}-3`]);
  }, 30_000);

  // The orphan this ticket exists for: a delete that drops the board but leaves
  // its BOARDKEY#<KEY> row behind, burning the key forever. Board keys are
  // globally unique, so re-creating under the same key proves the row was freed
  // — a stronger check than reading the table, and it needs no AWS credentials.
  it('frees the board key on delete, so it can be claimed again', async () => {
    const key = randKey();
    const first = await gql(CREATE_BOARD, { name: `mcp-e2e ${key}`, key });
    await gql(DELETE_BOARD, { boardId: first.createBoard.id });

    let reclaimedId = '';
    try {
      const second = await gql(CREATE_BOARD, { name: `mcp-e2e ${key}`, key });
      reclaimedId = second.createBoard.id;
      expect(second.createBoard.key).toBe(key);
    } finally {
      if (reclaimedId) await gql(DELETE_BOARD, { boardId: reclaimedId });
    }
  }, 30_000);
});
