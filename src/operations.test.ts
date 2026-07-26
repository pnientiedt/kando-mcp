import { describe, it, expect } from 'vitest';
import {
  GET_BOARD,
  ARCHIVED_ITEMS,
  CREATE_STORY,
  CREATE_SUBTASK,
  UPDATE_STORY,
  UPDATE_SUBTASK,
  UNARCHIVE_STORY,
  UNARCHIVE_SUBTASK,
} from './operations.js';

// The `creator` field (TSK-52) is provenance: who made the ticket. It must be
// SELECTED in every op that returns a story/subtask, or anything driving Kando
// through the MCP (the loop, /kando-refine, the kando skill) sees a ticket with
// no creator and reports it as "lost" even though the board still stores it.
// (It is read-only over MCP: the bot is EDITOR, and changing a creator needs
// OWNER, so `creator` is deliberately NOT a writable field on update_ticket.)
describe('MCP selections surface the ticket creator', () => {
  const opsReturningTickets = {
    GET_BOARD,
    ARCHIVED_ITEMS,
    CREATE_STORY,
    CREATE_SUBTASK,
    UPDATE_STORY,
    UPDATE_SUBTASK,
    UNARCHIVE_STORY,
    UNARCHIVE_SUBTASK,
  };
  for (const [name, op] of Object.entries(opsReturningTickets)) {
    it(`${name} selects creator`, () => {
      expect(op).toContain('creator');
    });
  }
});
