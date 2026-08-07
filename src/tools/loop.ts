import { z } from 'zod';
import { KandoError } from '../graphql.js';
import { type Gql, type ToolHost, toolText, resolveBoardId } from './read.js';
import { GET_BOARD, CREATE_TAG, NEXT_TASK } from '../operations.js';

const KNOWN_TAG_COLORS: Record<string, { colorBg: string; colorText: string }> = {
  claude: { colorBg: '#FFF1E0', colorText: '#B76E00' }, // orange
  'human-needed': { colorBg: '#FCE7F3', colorText: '#BE185D' }, // pink
  refined: { colorBg: '#E3F6EA', colorText: '#1F845A' }, // green
};

export function pickTagColors(name: string): { colorBg: string; colorText: string } {
  return KNOWN_TAG_COLORS[name.toLowerCase()] ?? { colorBg: '#EEF0F2', colorText: '#5C6B7A' };
}

/**
 * The tags this suite treats as "not workable by the loop": a ticket a human
 * has claimed, and one the loop has finished and parked on its branch awaiting
 * a batched deploy. The server resolves these NAMES per board and hard-codes
 * neither — they are this suite's conventions, not Kando's.
 *
 * See UNBLOCKING_TAGS below for the separate "does this ticket still block ITS
 * DEPENDENTS" question — the two overlap on `pending-ship` but answer different
 * questions.
 */
const EXCLUDE_TAGS = ['human-needed', 'pending-ship'];

/**
 * Tags whose presence tells Kando's blocker resolution "this ticket no longer
 * blocks its dependents" — distinct from EXCLUDE_TAGS, which says "don't serve
 * ME this ticket". Both lists contain `pending-ship` but mean different things:
 * a ticket the loop finished and parked awaiting a batched deploy should stop
 * blocking a dependent subtask right away (KDO-104/KDO-106), even though the
 * loop itself still must not be handed that ticket again.
 *
 * `human-needed` deliberately stays out of this list: a ticket stalled waiting
 * on a human is not finished, so it is right for it to keep blocking its
 * dependents — it should stay stopped, not silently unblock downstream work.
 */
export const UNBLOCKING_TAGS = ['pending-ship'];

// No `botEmail`: KDO-99 selects against the CALLER's identity server-side, so
// "assigned to a human" is "assigned to someone other than me" without this
// server looking a bot member up by email first.
export function registerLoopTools(server: ToolHost, gql: Gql) {
  server.registerTool(
    'ensure_tag',
    {
      description:
        "Ensure a board tag exists by name, creating it (fixed colors) if it doesn't exist yet. " +
        'Apply tags to tickets by NAME with update_ticket.',
      inputSchema: { board: z.string(), name: z.string() },
    },
    async ({ board, name }) => {
      const boardId = await resolveBoardId(gql, board);
      const data = await gql(GET_BOARD, { boardId });
      const existing = (data.getBoard.tags ?? []).find(
        (t: any) => (t.name ?? '').toLowerCase() === name.toLowerCase(),
      );
      if (existing) return toolText({ tag: existing.name, created: false });
      const { colorBg, colorText } = pickTagColors(name);
      const d = await gql(CREATE_TAG, { boardId, name, colorBg, colorText });
      return toolText({ tag: d.createTag.tag.name, created: true });
    },
  );

  server.registerTool(
    'next_task',
    {
      description:
        'Return the next workable ticket in a target (board key, or a KEY-N story/subtask), or {none:true}. ' +
        'Selection happens in Kando (KDO-99), so every consumer gets the same answer: subtasks of a STARTED ' +
        'container story first — one with a subtask past the first column, incl. Done — then standalone ' +
        'stories, then subtasks of untouched containers. Skips Done, snoozed, blocked (an unresolved ' +
        'blockedBy dependency, including one inherited from the container story), tickets assigned to ' +
        'someone else, and the human-needed / pending-ship tags. pending-ship marks a ticket the autonomous ' +
        'loop has finished and parked on its branch awaiting a batched deploy; the loop clears it once the ' +
        'batch ships. pending-ship also no longer blocks its dependents: a ticket carrying it counts as a ' +
        'resolved blocker, so a subtask and the dependent subtask waiting on it land in the same batch and ' +
        'the container story ships whole, instead of the dependent silently never being served. Work units ' +
        'are standalone stories and subtasks, never a container story.',
      inputSchema: { target: z.string().describe('board key/id, or a ticket KEY-N') },
    },
    async ({ target }) => {
      let list: any[];
      try {
        const vars = { target, excludeTags: EXCLUDE_TAGS, unblockingTags: UNBLOCKING_TAGS };
        list = (await gql(NEXT_TASK, vars)).nextTask ?? [];
      } catch (e) {
        // BAD_INPUT's table message is write-shaped ("that didn't save"), which
        // is wrong on a read. The server does not say which of the two causes
        // it was, so name both.
        if (e instanceof KandoError && e.token === 'BAD_INPUT') {
          throw new KandoError(
            `next_task could not use the target "${target}": it is either archived (restore it with ` +
              'unarchive_ticket) or not a board key / KEY-N ticket id.',
            'BAD_INPUT',
          );
        }
        throw e;
      }
      const top = list[0];
      if (!top) return toolText({ none: true });
      return toolText({
        ticket: top.ticket ?? null,
        // The wire says STORY/SUBTASK; this tool has always said story/subtask.
        kind: String(top.kind).toLowerCase(),
        id: top.id,
        ...(top.storyId ? { storyId: top.storyId } : {}),
        columnId: top.columnId,
        title: top.title,
      });
    },
  );
}
