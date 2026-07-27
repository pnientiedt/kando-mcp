# kando-loop Token Cost, Round 2 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop paying for the review diff twice, stop booting the reviewer with 33 unusable tool schemas, and let `get_board` return only the sections the caller asked for.

**Architecture:** Three independent changes. Task 1 is prose only (`SKILL.md`). Task 2 adds a shipped agent definition and teaches `init` to install it. Task 3 adds an optional `fields` parameter to the `get_board` MCP tool. Tasks 2 and 3 are TDD against the existing vitest suite.

**Tech Stack:** TypeScript, vitest, zod, MCP SDK. Markdown for the skill and agent definition.

**Predecessor:** `docs/superpowers/plans/2026-07-27-kando-loop-token-cost.md` (model tiering + `get_board` hoist), already merged into this branch.

## Global Constraints

- **Do not change review-gate behavior.** Max 3 rounds, a fresh independent reviewer every round, and the reviewer sees the **full** ticket diff on every round. Task 1 changes *who runs `git diff`*, never *what the reviewer sees*.
- **Do not touch `src/hookLogic.ts` or `assets/kando-workflow.mjs`.** A fourth idea (narrowing the record-then-code gate) was investigated and **rejected**: the hook is a `UserPromptSubmit` hook (`src/init.ts:112`), which fires only on human prompt submission — not on `Agent` dispatch or `SendMessage`. It costs ~150 tokens once per run, and narrowing it would weaken a working safety gate for no saving.
- `get_board`'s existing callers pass no `fields`. The parameter must be **optional and backwards-compatible** — absent means every section, exactly as today.
- Follow existing file conventions: pure exported helpers with unit tests in the sibling `*.test.ts`, `toolText(...)` for MCP returns, zod `.describe()` on every input field.

---

### Task 1: Reviewer runs its own `git diff`

Today the coordinator produces the diff and pastes it into the reviewer prompt, so the diff is paid for twice — once in the coordinator's context (on the session model) and again in the reviewer's. Across three review rounds the coordinator ends up holding three full diffs it never reads.

**Files:**
- Modify: `skills/kando-autonomous-loop/SKILL.md` (coordinator step 3, step 4a, and the reviewer prompt)

**Interfaces:**
- Consumes: the `model: sonnet` and `<userSub>` edits already on this branch.
- Produces: the `<base-sha>` placeholder, consumed by the reviewer prompt. Task 2 edits the same step 4a line — apply Task 1 first.

- [ ] **Step 1: Have the coordinator record the base sha before dispatching**

Find this exact line (coordinator step 3):

```
3. Dispatch ONE worker subagent (Agent tool, general-purpose, **`model: sonnet`**, **`run_in_background: false`**) with the **worker prompt** below for the ticket `KEY-N`, substituting this board's cached `<userSub>`, `<in-progress column>`, and `<last column>` into it. It works TDD-first, commits **locally (no push)**, and reports `ready-for-review` (or `blocked`).
```

Replace with:

```
3. Record the ticket's **base sha** (`git rev-parse HEAD`) — one line of output, and the reviewer's diff range for every round of this ticket. Then dispatch ONE worker subagent (Agent tool, general-purpose, **`model: sonnet`**, **`run_in_background: false`**) with the **worker prompt** below for the ticket `KEY-N`, substituting this board's cached `<userSub>`, `<in-progress column>`, and `<last column>` into it. It works TDD-first, commits **locally (no push)**, and reports `ready-for-review` (or `blocked`).
```

- [ ] **Step 2: Pass the range, not the diff**

Find this exact line (coordinator step 4a):

```
   a. Dispatch a **fresh, independent reviewer subagent** (Agent tool, general-purpose, **`model: sonnet`**, **`run_in_background: false`**) with the **reviewer prompt** below, giving it the ticket intent and the diff. It returns a BLOCKING list and an ADVISORY list.
```

Replace with:

```
   a. Dispatch a **fresh, independent reviewer subagent** (Agent tool, general-purpose, **`model: sonnet`**, **`run_in_background: false`**) with the **reviewer prompt** below, giving it the ticket intent and the **diff range** `<base-sha>..HEAD`. **Never run `git diff` yourself and never paste a diff into the prompt** — that pays for it twice, once in your context and once in the reviewer's, and you never read it. The reviewer runs the diff itself. Every round uses the SAME base sha, so each fresh reviewer sees the complete ticket diff, not just the latest fix. It returns a BLOCKING list and an ADVISORY list.
```

- [ ] **Step 3: Tell the reviewer to fetch its own diff**

Find this exact line in the reviewer prompt:

```
> You are an INDEPENDENT code reviewer for Kando ticket **KEY-N**. You did not write this change; do not trust any implementer narrative. You are given the ticket **intent** (title/body/Plan) and the **diff** (`git diff` of the ticket's local commits). Review the diff directly and sort findings into two buckets and report both. (Do NOT try to invoke the `/code-review` skill — it can't be called by a subagent; apply code-review principles yourself.)
```

Replace with:

```
> You are an INDEPENDENT code reviewer for Kando ticket **KEY-N**. You did not write this change; do not trust any implementer narrative. You are given the ticket **intent** (title/body/Plan) and a **diff range**. **Run `git diff <base-sha>..HEAD` yourself** — that is the complete change under review. Review the diff directly and sort findings into two buckets and report both. (Do NOT try to invoke the `/code-review` skill — it can't be called by a subagent; apply code-review principles yourself.)
```

- [ ] **Step 4: Verify**

Run: `grep -c "base-sha" skills/kando-autonomous-loop/SKILL.md`
Expected: `2` — one line in step 4a, one in the reviewer prompt. Step 1 writes "base sha" with a space and deliberately does not use the placeholder, so it does not count. If you get `1`, Step 2 or Step 3 did not apply.

Run: `git diff main...HEAD -- skills/kando-autonomous-loop/SKILL.md | grep -E "^[-+].*(round\+\+|round > 3|max \*\*3\*\*|rounds\))"`
Expected: no output — the review loop's round semantics are untouched.

- [ ] **Step 5: Commit**

```bash
git add skills/kando-autonomous-loop/SKILL.md
git commit -m "perf(loop): reviewer fetches its own diff from a range

The coordinator produced the diff and pasted it in, paying for it twice
-- once in its own context on the session model, once in the reviewer's
-- for a document only the reviewer reads. It now passes a base sha and
the reviewer runs git diff itself. Every round uses the same base, so a
fresh reviewer still sees the complete ticket diff."
```

---

### Task 2: Ship a tool-restricted reviewer agent

The reviewer reads a diff and writes nothing, but it boots with all 33 Kando MCP tool schemas. A dedicated agent definition with restricted `tools` cuts that from every reviewer boot, and makes "the reviewer is never the implementer" structural rather than advisory — it becomes unable to call `update_ticket` or push.

**Files:**
- Create: `agents/kando-reviewer.md`
- Modify: `src/init.ts:30-35` (`relTargets`), `src/init.ts:150-152` (`init` copy step), `src/init.ts:136-139` (doc comment)
- Modify: `package.json` (`files` array)
- Modify: `skills/kando-autonomous-loop/SKILL.md` (coordinator step 4a)
- Test: `src/init.test.ts`

**Interfaces:**
- Consumes: Task 1's edited step 4a line — the Step 6 find-string below includes Task 1's `<base-sha>` insertion.
- Produces: `relTargets(skillFiles, commandFiles, agentFiles?)` — a third **optional** parameter defaulting to `[]`, returning an added `agents` key. The existing two-argument call in `src/init.test.ts:51` must keep passing untouched.

- [ ] **Step 1: Write the failing test for `relTargets`**

Add to `src/init.test.ts`, inside the existing `describe('relTargets', ...)` block:

```ts
  it('lists agent destination paths', () => {
    const out = relTargets(['kando/SKILL.md'], ['kando-loop.md'], ['kando-reviewer.md']);
    expect(out.agents).toEqual(['.claude/agents/kando-reviewer.md']);
  });
  it('defaults agents to empty when none are given', () => {
    expect(relTargets(['kando/SKILL.md'], ['kando-loop.md']).agents).toEqual([]);
  });
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run src/init.test.ts -t relTargets`
Expected: FAIL — `expected undefined to deeply equal [ '.claude/agents/kando-reviewer.md' ]`.

- [ ] **Step 3: Implement `relTargets`**

In `src/init.ts`, replace the whole `relTargets` function:

```ts
/** Destination repo-relative paths for a set of skill + command + agent source files (used in tests). */
export function relTargets(skillFiles: string[], commandFiles: string[], agentFiles: string[] = []) {
  return {
    skills: skillFiles.map((f) => `.claude/skills/${f}`),
    commands: commandFiles.map((f) => `.claude/commands/${f}`),
    agents: agentFiles.map((f) => `.claude/agents/${f}`),
  };
}
```

- [ ] **Step 4: Run it to confirm it passes**

Run: `npx vitest run src/init.test.ts -t relTargets`
Expected: PASS, all four assertions in the block.

- [ ] **Step 5: Write the agent definition**

Create `agents/kando-reviewer.md`:

```markdown
---
name: kando-reviewer
description: Independent code reviewer for a Kando loop ticket. Reads a diff range and reports BLOCKING and ADVISORY findings. Never writes code and never touches the board.
tools: Read, Grep, Glob, Bash
model: sonnet
---

You review one Kando ticket's diff and report findings. You did not write the code.

You have no Kando board tools and no edit tools, and that is deliberate: your
independence is structural, not a promise. You cannot move a ticket, tag it, push, or
"just fix" what you find — you report, and the implementer fixes.

Use `Bash` only to read history: `git diff`, `git log`, `git show`. Never commit, never
push, never `git checkout`.

The dispatching prompt gives you the ticket intent and a diff range. Run the diff
yourself, review it directly, and report a BLOCKING list and an ADVISORY list exactly
as that prompt specifies.
```

- [ ] **Step 6: Point the loop at the new agent type**

In `skills/kando-autonomous-loop/SKILL.md`, find this exact fragment (it carries Task 1's edit):

```
   a. Dispatch a **fresh, independent reviewer subagent** (Agent tool, general-purpose, **`model: sonnet`**, **`run_in_background: false`**) with the **reviewer prompt** below,
```

Replace with:

```
   a. Dispatch a **fresh, independent reviewer subagent** (Agent tool, **`subagent_type: kando-reviewer`**, **`model: sonnet`**, **`run_in_background: false`**) with the **reviewer prompt** below,
```

Then add this paragraph immediately after the `## Model tiering — deliberate, not an oversight` section's final paragraph, before the `## Worker prompt` heading:

```markdown
**The reviewer runs as `kando-reviewer`, a tool-restricted agent** that `kando-mcp init`
installs into `.claude/agents/`. It has no board tools and no edit tools, so it *cannot*
move a ticket or push — the independence the review gate depends on is enforced by its
toolset rather than by asking nicely. It also skips loading 33 Kando tool schemas it
would never call.

**If that agent type is unavailable** (an older `init`, or a repo where the file was not
installed), fall back to `general-purpose` and carry on — the review still works, it just
costs more and leans on the prompt for independence.
```

- [ ] **Step 7: Write the failing test for install**

In `src/init.test.ts`, find the assertion block inside the test named `wires .mcp.json, skills/commands, the Node hook, settings, CLAUDE.md, gitignore` and add:

```ts
    expect(existsSync(join(dir, '.claude', 'agents', 'kando-reviewer.md'))).toBe(true);
```

- [ ] **Step 8: Run it to confirm it fails**

Run: `npx vitest run src/init.test.ts -t wires`
Expected: FAIL — `expected false to be true`.

- [ ] **Step 9: Make `init` copy the agents tree**

In `src/init.ts`, find:

```ts
  // 2) skills + commands (shipped in the package)
  copyTree(join(pkgRoot, '..', 'skills'), join(target, '.claude', 'skills'));
  copyTree(join(pkgRoot, '..', 'commands'), join(target, '.claude', 'commands'));
```

Replace with:

```ts
  // 2) skills + commands + agents (shipped in the package)
  copyTree(join(pkgRoot, '..', 'skills'), join(target, '.claude', 'skills'));
  copyTree(join(pkgRoot, '..', 'commands'), join(target, '.claude', 'commands'));
  copyTree(join(pkgRoot, '..', 'agents'), join(target, '.claude', 'agents'));
```

Then update the `init` doc comment: find `` * `.mcp.json` → `npx kando-mcp serve`, skills/commands into `.claude/`, the Node `` and replace `skills/commands` with `skills/commands/agents`.

- [ ] **Step 10: Add `agents` to the published package**

In `package.json`, find the `files` array and add `"agents",` immediately after `"skills",`. Without this the directory is absent from the npm tarball and `copyTree` silently no-ops for every installed user — the failure mode is invisible, which is why it gets its own step.

- [ ] **Step 11: Run the full suite**

Run: `npm test`
Expected: PASS, with the new `init` assertion satisfied.

- [ ] **Step 12: Commit**

```bash
git add agents/kando-reviewer.md src/init.ts src/init.test.ts package.json skills/kando-autonomous-loop/SKILL.md
git commit -m "perf(loop): review under a tool-restricted kando-reviewer agent

The reviewer reads a diff and writes nothing, yet booted with all 33
Kando tool schemas. It now runs as a shipped agent definition limited to
Read/Grep/Glob/Bash, installed by init into .claude/agents/. Beyond the
tokens, it makes reviewer independence structural: the agent cannot move
a ticket or push even if instructed to."
```

---

### Task 3: `get_board` field selection

`get_board` returns board + every non-archived ticket + tags + releases + members. The coordinator's once-per-board call wants three fields and pays for all of it.

**Files:**
- Modify: `src/tools/read.ts:52-78` (`get_board` registration), plus a new exported helper
- Modify: `skills/kando-autonomous-loop/SKILL.md` (coordinator preamble)
- Test: `src/tools/read.test.ts`

**Interfaces:**
- Consumes: nothing from Tasks 1–2.
- Produces: `selectBoardFields(payload, fields?)` and the `BoardField` type, exported from `src/tools/read.ts`.

- [ ] **Step 1: Write the failing test**

Add to `src/tools/read.test.ts`:

```ts
describe('selectBoardFields', () => {
  const full = {
    board: { id: 'b1' },
    items: [{ ticket: 'TSK-1' }],
    tags: [{ id: 't1' }],
    releases: [{ id: 'r1' }],
    members: [{ userSub: 'u1' }],
  };

  it('returns every section when no fields are given', () => {
    expect(selectBoardFields(full)).toEqual(full);
  });

  it('returns only the requested sections', () => {
    expect(selectBoardFields(full, ['board', 'members'])).toEqual({
      board: { id: 'b1' },
      members: [{ userSub: 'u1' }],
    });
  });

  it('treats an empty list as every section, never as nothing', () => {
    expect(selectBoardFields(full, [])).toEqual(full);
  });
});
```

Extend the import at the top of the file to `import { resolveBoardId, selectBoardFields } from './read.js';`

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run src/tools/read.test.ts`
Expected: FAIL — `selectBoardFields is not a function` (or an import error).

- [ ] **Step 3: Implement the helper**

In `src/tools/read.ts`, add above the `get_board` registration:

```ts
export type BoardField = 'board' | 'items' | 'tags' | 'releases' | 'members';

/**
 * Narrow a get_board payload to the requested sections. An absent or empty list means
 * every section — callers that pass nothing must keep seeing the whole board, and an
 * empty array is far more likely to be a caller bug than a request for nothing.
 */
export function selectBoardFields<T extends Record<string, unknown>>(
  payload: T,
  fields?: BoardField[],
): Partial<T> {
  if (!fields || fields.length === 0) return payload;
  const out: Partial<T> = {};
  for (const f of fields) {
    if (f in payload) out[f as keyof T] = payload[f as keyof T];
  }
  return out;
}
```

- [ ] **Step 4: Run it to confirm it passes**

Run: `npx vitest run src/tools/read.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire it into the tool**

In `src/tools/read.ts`, change the `get_board` `inputSchema` from:

```ts
      inputSchema: { board: z.string().describe('board key (e.g. TSK) or id') },
```

to:

```ts
      inputSchema: {
        board: z.string().describe('board key (e.g. TSK) or id'),
        fields: z
          .array(z.enum(['board', 'items', 'tags', 'releases', 'members']))
          .optional()
          .describe('sections to return; omit for all. Use ["board","members"] for just columns + userSubs.'),
      },
```

Change the handler signature from `async ({ board }) => {` to `async ({ board, fields }) => {`, and wrap the return: change `return toolText({` to `return toolText(selectBoardFields({`, then change the closing `      });` of that object to `      }, fields));`.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS. Existing callers pass no `fields` and must be unaffected.

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 7: Teach the coordinator to ask for less**

In `skills/kando-autonomous-loop/SKILL.md`, find:

```
**On each board's first ticket, call `get_board` once — then never again for that
board.** The worker does not call it.
```

Replace with:

```
**On each board's first ticket, call `get_board` once — then never again for that
board.** Pass **`fields: ["board", "members"]`**: you need the columns and the bot's
`userSub`, not every ticket, tag, and release on the board. The worker does not call it.
```

- [ ] **Step 8: Commit**

```bash
git add src/tools/read.ts src/tools/read.test.ts skills/kando-autonomous-loop/SKILL.md
git commit -m "feat(get_board): optional fields parameter

get_board returned board + every ticket + tags + releases + members
unconditionally. Callers wanting columns and userSubs paid for all of
it. fields is optional and absent means everything, so existing callers
are unaffected; the loop coordinator now asks for board + members."
```

---

### Task 4: Final gate

**Files:** none — verification only.

- [ ] **Step 1: Full suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: both clean.

- [ ] **Step 2: Confirm the rejected idea stayed rejected**

Run: `git diff main...HEAD --stat -- src/hookLogic.ts assets/kando-workflow.mjs`
Expected: no output. If either file appears, revert it — see Global Constraints.

- [ ] **Step 3: Confirm the package ships the agents directory**

Run: `npm pack --dry-run 2>&1 | grep agents/`
Expected: one line listing `agents/kando-reviewer.md`. If empty, Task 2 Step 10 was skipped.

- [ ] **Step 4: Read the changed skill end to end**

Read `skills/kando-autonomous-loop/SKILL.md` and confirm:

1. The coordinator is told, in step 4a, never to run `git diff` itself.
2. The reviewer prompt tells the reviewer to run it, and the `kando-reviewer` agent's `tools` list includes `Bash` so it can.
3. The `subagent_type: kando-reviewer` dispatch is paired with the stated `general-purpose` fallback.
4. The `## Never` section and the review round semantics are unchanged.
