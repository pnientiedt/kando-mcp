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
// SELECTED in every op whose data REACHES A CALLER as a ticket, or anything
// driving Kando through the MCP (the loop, /kando-refine, the kando skill) sees
// a ticket with no creator and reports it as "lost" even though the board still
// stores it. (It is read-only over MCP: the bot is EDITOR, and changing a
// creator needs OWNER, so `creator` is deliberately NOT writable.)
//
// That set is now the READ ops alone. Mutations return an ack — a ticket id and
// what changed — and never a ticket object, so there is no creator to lose. See
// `leanDetail` for where provenance actually surfaces: get_ticket.
describe('MCP read selections surface the ticket creator', () => {
  for (const [name, op] of Object.entries({ GET_BOARD, ARCHIVED_ITEMS })) {
    it(`${name} selects creator`, () => {
      expect(op).toContain('creator');
    });
  }
});

// KDO-94 blocking dependencies. `blockedBy` must be SELECTED in every read op
// whose data reaches a caller as a ticket: next_task's eligibility check and
// get_ticket's detail are both built on it, and an unselected field reads as
// "nothing blocks this" — which is the exact wrong answer.
describe('MCP read selections surface blockedBy', () => {
  for (const [name, op] of Object.entries({ GET_BOARD, ARCHIVED_ITEMS })) {
    it(`${name} selects blockedBy`, () => {
      expect(op).toContain('blockedBy');
    });
  }
});

describe('mutation selections are slim', () => {
  const mutations = {
    UPDATE_STORY,
    UPDATE_SUBTASK,
    CREATE_STORY,
    CREATE_SUBTASK,
    UNARCHIVE_STORY,
    UNARCHIVE_SUBTASK,
  };

  /**
   * `body:` is a legitimate ARGUMENT on these mutations — what must not appear is
   * `body` in the returned SELECTION SET, so assert against that block alone.
   */
  const selectionSet = (q: string) => q.match(/(?:story|subtask)\s*\{([^}]*)\}/)?.[1] ?? '';

  it('never ask for a body or nested subtasks — the ack does not need them', () => {
    for (const [name, q] of Object.entries(mutations)) {
      const sel = selectionSet(q);
      expect(sel, `${name} must return a selection`).not.toBe('');
      expect(sel, `${name} must not select body`).not.toMatch(/\bbody\b/);
      expect(sel, `${name} must not select subtasks`).not.toMatch(/\bsubtasks\b/);
    }
  });

  it('still return enough to build the ack', () => {
    for (const [name, q] of Object.entries(mutations)) {
      expect(q, `${name} needs num`).toMatch(/\bnum\b/);
    }
  });

  it('leaves the read path fat — next_task and planReorder depend on it', () => {
    for (const f of ['body', 'rank', 'visibleAt', 'assignee', 'archivedAt']) {
      expect(GET_BOARD).toMatch(new RegExp(`\\b${f}\\b`));
    }
    expect(GET_BOARD).toMatch(/subtasks\s*\{/);
  });
});
