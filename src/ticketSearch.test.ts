import { describe, it, expect } from 'vitest';
import { buildTicketFilter, leanSummary } from './ticketSearch.js';

describe('buildTicketFilter', () => {
  it('is empty when nothing was asked for — the server owns every default', () => {
    expect(buildTicketFilter({})).toEqual({});
  });

  it('uppercases the enums for the wire', () => {
    expect(
      buildTicketFilter({ kind: 'subtask', archived: 'all', snoozed: 'only', tagMode: 'all', tags: ['claude'] }),
    ).toEqual({ kind: 'SUBTASK', archived: 'ALL', snoozed: 'ONLY', tagMode: 'ALL', tags: ['claude'] });
  });

  it('passes names, "me" and free text through untouched', () => {
    expect(
      buildTicketFilter({
        tags: ['claude', 'refined'],
        releases: ['v1.0'],
        assignees: ['me', 'sub-123'],
        columns: ['In Progress'],
        text: 'deploy',
      }),
    ).toEqual({
      tags: ['claude', 'refined'],
      releases: ['v1.0'],
      assignees: ['me', 'sub-123'],
      columns: ['In Progress'],
      text: 'deploy',
    });
  });

  it('adds boardIds only when board ids were resolved', () => {
    expect(buildTicketFilter({}, ['b1', 'b2'])).toEqual({ boardIds: ['b1', 'b2'] });
    expect(buildTicketFilter({}, [])).toEqual({});
    expect(buildTicketFilter({})).toEqual({});
  });

  it('treats an empty list as "no filter", never as "match nothing"', () => {
    expect(buildTicketFilter({ tags: [], columns: [], assignees: [] })).toEqual({});
  });

  it('does not send tagMode on its own — it only qualifies tags', () => {
    expect(buildTicketFilter({ tagMode: 'all' })).toEqual({});
  });
});

describe('leanSummary', () => {
  const row = {
    ticket: 'KDO-12',
    parent: null,
    title: 'Batched deploys',
    columnLabel: 'In Progress',
    subtaskCount: 0,
    tags: ['claude'],
    releaseName: null,
    assignee: 'sub-1',
    assigneeEmail: 'bot@example.com',
    visibleAt: null,
    archivedAt: null,
  };

  it('keeps the identifying fields and drops every empty one', () => {
    expect(leanSummary(row)).toEqual({
      ticket: 'KDO-12',
      title: 'Batched deploys',
      col: 'In Progress',
      tags: ['claude'],
      assignee: 'bot@example.com',
    });
  });

  it('carries the parent for a subtask and the release when set', () => {
    expect(leanSummary({ ...row, parent: 'KDO-1', releaseName: 'v1.0' })).toMatchObject({
      parent: 'KDO-1',
      release: 'v1.0',
    });
  });

  it('marks a container with its live subtask count, never a standalone with 0', () => {
    expect(leanSummary({ ...row, subtaskCount: 3 }).subtasks).toBe(3);
    expect(leanSummary(row)).not.toHaveProperty('subtasks');
  });

  it('derives snoozed from a FUTURE visibleAt only', () => {
    expect(leanSummary({ ...row, visibleAt: '2999-01-01T00:00:00Z' }).snoozed).toBe(true);
    expect(leanSummary({ ...row, visibleAt: '2000-01-01T00:00:00Z' })).not.toHaveProperty('snoozed');
  });

  it('carries archivedAt — recency survives, since the sort no longer conveys it', () => {
    expect(leanSummary({ ...row, archivedAt: '2026-08-01T10:00:00Z' }).archivedAt).toBe(
      '2026-08-01T10:00:00Z',
    );
  });

  it('falls back to the raw sub when the server could not name the assignee', () => {
    expect(leanSummary({ ...row, assigneeEmail: null }).assignee).toBe('sub-1');
  });

  it('never carries a body — there is no body to carry', () => {
    expect(JSON.stringify(leanSummary({ ...row, body: 'SECRET SPEC' }))).not.toContain('SECRET');
  });
});
