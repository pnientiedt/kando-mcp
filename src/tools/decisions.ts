import { z } from 'zod';
import { KandoError } from '../graphql.js';
import { type Gql, type ToolHost, toolText, resolveBoardId } from './read.js';
import { parseDecisionId, resolveDecisionRef } from '../tickets.js';
import { resolveAssignee } from '../resolve.js';
import {
  GET_BOARD,
  CREATE_DECISION,
  LIST_DECISIONS,
  RESOLVE_DECISION,
  REOPEN_DECISION,
  DELETE_DECISION,
} from '../operations.js';

const bad = (msg: string) => new KandoError(msg, 'BAD_INPUT');
const eq = (a: unknown, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();

/** Fetch the board once — resolves the board KEY (for `KEY-D-N`) and, when needed, `assignee`. */
async function boardOf(gql: Gql, board: string) {
  const boardId = await resolveBoardId(gql, board);
  const bc = (await gql(GET_BOARD, { boardId })).getBoard;
  return { boardId, bc };
}

const decisionTicket = (key: string | null, num: unknown): string | null =>
  key && typeof num === 'number' ? `${key}-D-${num}` : null;

/** Maps a raw Decision (the operations.ts field selection) to the tool's lean row. */
function toDecisionRow(d: any, key: string | null) {
  return {
    decision: decisionTicket(key, d.num),
    title: d.title,
    description: d.description ?? null,
    options: d.options ?? [],
    assignee: d.assignee ?? null,
    status: d.status,
    resolution: d.resolution ?? null,
    keywords: d.keywords ?? [],
  };
}

/**
 * `chosenOption` matched against an option's LABEL first, falling back to its
 * raw id — same resolve-by-name-or-id convention as resolveTagIds/resolveReleaseId,
 * just label-first per this ticket's spec (options rarely collide on id either way).
 */
function resolveOptionId(decision: any, value: string): string {
  const opts: any[] = decision.options ?? [];
  const byLabel = opts.filter((o) => eq(o.label, value));
  if (byLabel.length === 1) return byLabel[0].id;
  if (byLabel.length > 1) throw bad(`Option "${value}" is ambiguous on this decision; pass its id instead.`);
  const byId = opts.find((o) => o.id === value);
  if (byId) return byId.id;
  const labels = opts.map((o) => `"${o.label}"`).join(', ') || '(none yet)';
  throw bad(`No option "${value}" on this decision. Existing options: ${labels}.`);
}

const DECISION_FILTERS = { relevant: 'RELEVANT', all: 'ALL', history: 'HISTORY' } as const;

const optionInputShape = z.object({
  label: z.string(),
  rating: z.number().min(1).max(100).optional().describe('1-100'),
  reasoning: z.string().optional(),
});

export function registerDecisionTools(server: ToolHost, gql: Gql, botEmail: string | null = null) {
  server.registerTool(
    'create_decision',
    {
      description:
        'Raise a decision: pause and ask a human to pick among rated/reasoned options, or supply a ' +
        'custom answer, rather than a unit of work to do. Returns a KEY-D-N — a decision is addressed ' +
        'like a ticket but is never one, and vice versa.',
      inputSchema: {
        board: z.string(),
        title: z.string(),
        description: z.string().optional(),
        options: z.array(optionInputShape).min(1).describe('at least one option'),
        assignee: z.string().optional().describe('member email, userSub, or "me"'),
        keywords: z
          .array(z.string())
          .optional()
          .describe('up to 10, 40 chars each — for later self-identification, e.g. by one workflow run'),
      },
    },
    async ({ board, options, keywords, assignee, ...rest }) => {
      // Validated before any network call — a clear message beats letting the
      // server's BAD_INPUT be the only signal.
      if (!options.length) throw bad('At least one option is required.');
      if (keywords !== undefined) {
        if (keywords.length > 10) throw bad(`At most 10 keywords are allowed (got ${keywords.length}).`);
        const long = keywords.find((k: string) => k.length > 40);
        if (long) throw bad(`Keyword "${long}" exceeds 40 characters.`);
      }
      const { boardId, bc } = await boardOf(gql, board);
      const vars: Record<string, unknown> = { boardId, options, ...rest };
      if (keywords !== undefined) vars.keywords = keywords;
      if (assignee !== undefined) vars.assignee = resolveAssignee(bc, assignee, botEmail);
      const data = await gql(CREATE_DECISION, vars);
      const decision = data.createDecision.decision;
      const key = bc.board?.key ?? null;
      return toolText({ decision: decisionTicket(key, decision.num), title: rest.title });
    },
  );

  server.registerTool(
    'list_decisions',
    {
      description:
        "The poll tool: list a board's decisions, or — filter:'history' with resolvedAfter — poll for " +
        "ones resolved since a given time (optionally narrowed by keyword). Feed the response's " +
        "latestResolvedAt straight back in as the NEXT call's resolvedAfter; that is the whole workflow " +
        '("last seen resolved decision was at T; poll again a few minutes later for anything resolved ' +
        'since T") without computing the boundary yourself.',
      inputSchema: {
        board: z.string(),
        filter: z.enum(['relevant', 'all', 'history']).optional().describe("default 'relevant'"),
        keyword: z.string().optional().describe('exact match against a decision\'s keywords'),
        resolvedAfter: z
          .string()
          .optional()
          .describe("ISO datetime; HISTORY-only — rejected with filter:'relevant'/'all'"),
        cursor: z.string().optional(),
      },
    },
    async ({ board, filter, keyword, resolvedAfter, cursor }: {
      board: string;
      filter?: keyof typeof DECISION_FILTERS;
      keyword?: string;
      resolvedAfter?: string;
      cursor?: string;
    }) => {
      const backendFilter = DECISION_FILTERS[filter ?? 'relevant'];
      // Rejected before any network call: the backend silently IGNORES this
      // combination rather than erroring, which is exactly the silent no-op
      // this repo's tools prefer to refuse loudly instead.
      if (resolvedAfter !== undefined && backendFilter !== 'HISTORY') {
        throw bad("resolvedAfter is only valid with filter: 'history' (only resolved decisions have a resolvedAt).");
      }
      const { boardId, bc } = await boardOf(gql, board);
      const key = bc.board?.key ?? null;
      const data = await gql(LIST_DECISIONS, {
        boardId,
        filter: backendFilter,
        keyword,
        resolvedAfter,
        cursor,
      });
      const page = data.listDecisions;
      const items: any[] = page.items ?? [];
      const out: Record<string, unknown> = {
        decisions: items.map((d) => toDecisionRow(d, key)),
        totalCount: page.totalCount,
      };
      if (page.nextCursor) out.nextCursor = page.nextCursor;
      if (backendFilter === 'HISTORY') {
        const resolvedAts: string[] = items
          .map((d) => d.resolution?.resolvedAt)
          .filter((v): v is string => Boolean(v));
        if (resolvedAts.length) {
          out.latestResolvedAt = resolvedAts.reduce((a, b) => (a > b ? a : b));
        }
      }
      return toolText(out);
    },
  );

  server.registerTool(
    'resolve_decision',
    {
      description:
        'Resolve a decision directly — e.g. when a human states their choice in chat rather than the ' +
        'board UI. Exactly one of chosenOption (an option\'s label, or its raw id) or customOption is ' +
        'required.',
      inputSchema: {
        decision: z.string().describe('decision id, e.g. TSK-D-3'),
        chosenOption: z.string().optional().describe("an existing option's label or id"),
        customOption: z
          .object({ label: z.string(), reasoning: z.string().optional() })
          .optional()
          .describe('a custom answer not among the offered options'),
        correctedReasoning: z
          .string()
          .optional()
          .describe(
            "corrects an existing option's stated reasoning (preserving the original); only valid " +
              "alongside chosenOption, rejected with customOption. '' clears it, omitted leaves it unchanged.",
          ),
      },
    },
    async ({ decision, chosenOption, customOption, correctedReasoning }) => {
      // Mirrors the backend's own BAD_INPUT rule — checked before resolving
      // the ref (the first network call this tool would otherwise make).
      if ((chosenOption === undefined) === (customOption === undefined)) {
        throw bad('Provide exactly one of chosenOption or customOption.');
      }
      if (correctedReasoning !== undefined && customOption !== undefined) {
        throw bad('correctedReasoning is only valid alongside chosenOption, not customOption.');
      }
      const ref = await resolveDecisionRef(gql, decision);
      const chosenOptionId = chosenOption !== undefined ? resolveOptionId(ref.decision, chosenOption) : undefined;
      const vars: Record<string, unknown> = {
        boardId: ref.boardId,
        decisionId: ref.decision.id,
        chosenOptionId,
        customOption,
      };
      if (correctedReasoning !== undefined) vars.correctedReasoning = correctedReasoning;
      const d = await gql(RESOLVE_DECISION, vars);
      const resolved =
        customOption?.label ??
        (ref.decision.options ?? []).find((o: any) => o.id === chosenOptionId)?.label ??
        chosenOption;
      void d;
      const { key, num } = parseDecisionId(decision);
      return toolText({ decision: `${key}-D-${num}`, resolved });
    },
  );

  server.registerTool(
    'reopen_decision',
    {
      description:
        'Reopen an already-resolved decision — a no-op (not an error) on one that is already open.',
      inputSchema: { decision: z.string().describe('decision id, e.g. TSK-D-3') },
    },
    async ({ decision }) => {
      const ref = await resolveDecisionRef(gql, decision);
      await gql(REOPEN_DECISION, { boardId: ref.boardId, decisionId: ref.decision.id });
      const { key, num } = parseDecisionId(decision);
      return toolText({ decision: `${key}-D-${num}`, reopened: true });
    },
  );

  server.registerTool(
    'delete_decision',
    {
      description:
        'Hard-delete a decision — permanent and unrecoverable. This is a cleanup action for a decision ' +
        'raised in error, not a step in the normal create/resolve/reopen workflow; there is no undo. ' +
        'Works identically on an OPEN or RESOLVED decision. A server NOT_FOUND (unknown or ' +
        'already-deleted decision) propagates unchanged.',
      inputSchema: { decision: z.string().describe('decision id, e.g. TSK-D-3') },
    },
    async ({ decision }) => {
      const ref = await resolveDecisionRef(gql, decision);
      await gql(DELETE_DECISION, { boardId: ref.boardId, decisionId: ref.decision.id });
      const { key, num } = parseDecisionId(decision);
      return toolText({ decision: `${key}-D-${num}`, deleted: true });
    },
  );
}
