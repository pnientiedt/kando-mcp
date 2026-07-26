# kando-loop Liveness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `/kando-loop` stalling silently, by replacing the worker's open-ended `gh run watch` with a CI-agnostic background poller whose probe command is composed by the LLM.

**Architecture:** A new self-contained Node asset, `assets/kando-verify-wait.mjs`, polls a shell command it is handed and reads only its exit code (`0` green / `1` red / `2` pending / anything else malformed). It contains no knowledge of any CI system — the coordinator composes the probe by reading the repo. The long wait moves from the worker to the coordinator, which arms the poller as a `persistent` Monitor and resumes on heartbeats; every other wait becomes a synchronous subagent dispatch.

**Tech Stack:** Node 20+ ESM, vitest, esbuild (existing build only — the new asset is *not* bundled).

## Global Constraints

- `assets/kando-verify-wait.mjs` MUST be self-contained: no imports beyond `node:child_process`, `node:url`. It runs standalone in a target repo where nothing else is installed.
- Node `>=20`, ESM (`"type": "module"`), cross-platform (Windows, Linux, macOS).
- Waiter exit codes are fixed: `0` green, `1` red, `3` malformed probe.
- Probe exit codes are fixed: `0` green, `1` red, `2` pending, anything else malformed.
- A malformed probe is NEVER treated as green.
- Backoff schedule: 30s → 60s → 300s, then held at 300s.
- Heartbeat: on status change, or every 300000ms — never more often. `Monitor` auto-stops sources that emit too many events.
- Per-probe-invocation timeout: 60000ms default; a timed-out probe counts as **pending**, not failure.
- Tests live in `src/`, matching every other test in this repo. `tsconfig.json` includes only `src` and `__tests__` with `allowJs` off, so the untyped `.mjs` asset MUST be loaded via a dynamic import with a runtime-constructed specifier.
- Existing test suite must stay green: `npm test` and `npm run typecheck`.

---

### Task 1: Waiter pure functions

**Files:**
- Create: `assets/kando-verify-wait.mjs`
- Test: `src/verifyWait.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `nextDelay(pollIndex, intervals?) → number`, `classifyExit(code) → 'green'|'red'|'pending'|'malformed'`, `shouldHeartbeat(prevStatus, status, msSinceLastHeartbeat, heartbeatMs?) → boolean`, and the constants `DEFAULT_INTERVALS_MS: number[]`, `HEARTBEAT_INTERVAL_MS: number`, `DEFAULT_PROBE_TIMEOUT_MS: number`, `EXIT: {green:0, red:1, malformed:3}`. Task 2 builds `watch()` on all of these.

- [ ] **Step 1: Write the failing test**

Create `src/verifyWait.test.ts`:

```ts
import { describe, it, expect } from 'vitest';

// Loaded through a runtime-constructed specifier: tsconfig includes only `src`
// and has allowJs off, so a static import of the untyped .mjs would break
// `tsc --noEmit`. The variable specifier keeps it opaque to tsc.
const assetUrl = new URL('../assets/kando-verify-wait.mjs', import.meta.url).href;
const w: any = await import(/* @vite-ignore */ assetUrl);

describe('nextDelay', () => {
  it('ramps 30s -> 60s -> 300s and then holds', () => {
    expect(w.nextDelay(0)).toBe(30_000);
    expect(w.nextDelay(1)).toBe(60_000);
    expect(w.nextDelay(2)).toBe(300_000);
    expect(w.nextDelay(3)).toBe(300_000);
    expect(w.nextDelay(99)).toBe(300_000);
  });

  it('honours a custom schedule', () => {
    expect(w.nextDelay(0, [5, 10])).toBe(5);
    expect(w.nextDelay(7, [5, 10])).toBe(10);
  });
});

describe('classifyExit', () => {
  it('maps 0/1/2 to green/red/pending', () => {
    expect(w.classifyExit(0)).toBe('green');
    expect(w.classifyExit(1)).toBe('red');
    expect(w.classifyExit(2)).toBe('pending');
  });

  it('treats every other code as malformed, never green', () => {
    expect(w.classifyExit(3)).toBe('malformed');
    expect(w.classifyExit(127)).toBe('malformed');
    expect(w.classifyExit(null)).toBe('malformed');
  });
});

describe('shouldHeartbeat', () => {
  it('fires on a status change', () => {
    expect(w.shouldHeartbeat(null, 'pending', 0)).toBe(true);
    expect(w.shouldHeartbeat('pending', 'green', 0)).toBe(true);
  });

  it('fires on the 5-minute tick when the status has not changed', () => {
    expect(w.shouldHeartbeat('pending', 'pending', 300_000)).toBe(true);
    expect(w.shouldHeartbeat('pending', 'pending', 400_000)).toBe(true);
  });

  it('stays quiet between ticks', () => {
    expect(w.shouldHeartbeat('pending', 'pending', 299_999)).toBe(false);
    expect(w.shouldHeartbeat('pending', 'pending', 0)).toBe(false);
  });
});

describe('EXIT', () => {
  it('pins the waiter exit codes', () => {
    expect(w.EXIT).toEqual({ green: 0, red: 1, malformed: 3 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/verifyWait.test.ts`
Expected: FAIL — cannot find module `../assets/kando-verify-wait.mjs`.

- [ ] **Step 3: Write minimal implementation**

Create `assets/kando-verify-wait.mjs`:

```js
// Kando loop verification waiter — polls a probe command until it reaches a
// terminal state. Deliberately knows NOTHING about any CI system: the caller
// composes the probe by reading the repo. Self-contained (no imports beyond
// node builtins) because `init` copies this file into a target repo where
// nothing else is installed.
//
// Probe contract (exit code is the whole interface):
//   0 = green, 1 = red, 2 = still pending, anything else = malformed probe.

export const DEFAULT_INTERVALS_MS = [30_000, 60_000, 300_000];
export const HEARTBEAT_INTERVAL_MS = 300_000;
export const DEFAULT_PROBE_TIMEOUT_MS = 60_000;

/** Waiter process exit codes. A malformed probe is never folded into green. */
export const EXIT = { green: 0, red: 1, malformed: 3 };

/** Delay before the poll AFTER index `pollIndex`: ramps, then holds the last. */
export function nextDelay(pollIndex, intervals = DEFAULT_INTERVALS_MS) {
  const i = Math.max(0, Math.min(pollIndex, intervals.length - 1));
  return intervals[i];
}

/** Map a probe's exit code to a verdict. Unknown codes are malformed, not green. */
export function classifyExit(code) {
  if (code === 0) return 'green';
  if (code === 1) return 'red';
  if (code === 2) return 'pending';
  return 'malformed';
}

/**
 * Emit a heartbeat on a status change, or once the last one is a full interval
 * old. Kept sparse on purpose: Monitor auto-stops sources that emit too much.
 */
export function shouldHeartbeat(prevStatus, status, msSinceLastHeartbeat, heartbeatMs = HEARTBEAT_INTERVAL_MS) {
  if (prevStatus !== status) return true;
  return msSinceLastHeartbeat >= heartbeatMs;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/verifyWait.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Verify typecheck stays green**

Run: `npm run typecheck`
Expected: no errors. (If tsc complains about the dynamic import, the specifier is not opaque enough — confirm `assetUrl` is a `const` variable and not inlined.)

- [ ] **Step 6: Commit**

```bash
git add assets/kando-verify-wait.mjs src/verifyWait.test.ts
git commit -m "feat(waiter): probe exit-code classification, backoff, heartbeat cadence"
```

---

### Task 2: Probe execution and the watch loop

**Files:**
- Modify: `assets/kando-verify-wait.mjs`
- Test: `src/verifyWait.test.ts`

**Interfaces:**
- Consumes: `nextDelay`, `classifyExit`, `shouldHeartbeat`, `EXIT`, `DEFAULT_INTERVALS_MS`, `DEFAULT_PROBE_TIMEOUT_MS`, `HEARTBEAT_INTERVAL_MS` from Task 1.
- Produces: `runProbe(probe, timeoutMs, spawnFn?) → Promise<{code:number, out:string}>`, `watch(opts) → Promise<number>`, `parseArgs(argv) → {probe, intervals, probeTimeoutMs}`. Task 3 needs none of these; Task 4 documents the CLI they back.

- [ ] **Step 1: Write the failing test**

Append to `src/verifyWait.test.ts`:

```ts
describe('watch', () => {
  // A fake probe queue lets the loop be tested without real time or processes.
  const harness = (codes: number[]) => {
    const logs: string[] = [];
    let clock = 0;
    let call = 0;
    return {
      logs,
      opts: {
        probe: 'fake-probe',
        intervals: [1],
        probeTimeoutMs: 10,
        heartbeatMs: 300_000,
        log: (m: string) => logs.push(m),
        sleep: async (ms: number) => { clock += ms; },
        now: () => clock,
        runProbeFn: async () => ({ code: codes[Math.min(call++, codes.length - 1)], out: '' }),
      },
    };
  };

  it('returns green and stops polling', async () => {
    const h = harness([0]);
    expect(await w.watch(h.opts)).toBe(0);
  });

  it('keeps polling while pending, then reports red', async () => {
    const h = harness([2, 2, 1]);
    expect(await w.watch(h.opts)).toBe(1);
  });

  it('exits 3 on a malformed probe and says so loudly', async () => {
    const h = harness([127]);
    expect(await w.watch(h.opts)).toBe(3);
    expect(h.logs.join('\n')).toMatch(/MALFORMED PROBE/);
  });

  it('echoes the probe command in its first heartbeat', async () => {
    const h = harness([2, 0]);
    await w.watch(h.opts);
    expect(h.logs[0]).toContain('fake-probe');
  });

  it('stays quiet across unchanged pending polls', async () => {
    const h = harness([2, 2, 2, 2, 0]);
    await w.watch(h.opts);
    // One for the first pending, one for the green transition. No spam.
    expect(h.logs).toHaveLength(2);
  });
});

describe('runProbe', () => {
  it('reports a real command exit code', async () => {
    expect((await w.runProbe('exit 2', 5000)).code).toBe(2);
  });

  it('counts a probe that overruns its timeout as pending, not failure', async () => {
    const r = await w.runProbe('sleep 5', 150);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/exceeded/);
  });
});

describe('parseArgs', () => {
  it('reads the probe and the timing overrides', () => {
    const a = w.parseArgs(['--probe', 'gh run view 1', '--interval-ms', '50', '--probe-timeout-ms', '99']);
    expect(a.probe).toBe('gh run view 1');
    expect(a.intervals).toEqual([50]);
    expect(a.probeTimeoutMs).toBe(99);
  });

  it('defaults the timings', () => {
    const a = w.parseArgs(['--probe', 'x']);
    expect(a.intervals).toEqual([30_000, 60_000, 300_000]);
    expect(a.probeTimeoutMs).toBe(60_000);
  });

  it('rejects a missing probe', () => {
    expect(() => w.parseArgs([])).toThrow(/--probe/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/verifyWait.test.ts`
Expected: FAIL — `w.watch is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `assets/kando-verify-wait.mjs`:

```js
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/**
 * Run the probe once. A probe that overruns `timeoutMs` is killed and reported
 * as pending (code 2) — a hanging `gh`/`curl` must never wedge the poller, and
 * must never be mistaken for a verdict.
 */
export function runProbe(probe, timeoutMs, spawnFn = spawn) {
  return new Promise((resolve) => {
    let out = '';
    let timedOut = false;
    let child;
    try {
      child = spawnFn(probe, { shell: true });
    } catch {
      resolve({ code: 127, out: 'probe failed to start' });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout?.on('data', (d) => { out += String(d); });
    child.stderr?.on('data', (d) => { out += String(d); });
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ code: 127, out: out + 'probe failed to start' });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) resolve({ code: 2, out: `${out}\n[probe exceeded ${timeoutMs}ms — counted as pending]` });
      else resolve({ code: code ?? 127, out });
    });
  });
}

const lastLine = (s) => (s.trim() ? s.trim().split('\n').pop() : '');

/**
 * Poll until the probe reaches a terminal state. While it reports pending this
 * runs indefinitely by design — a slow-but-healthy pipeline must not be failed
 * on a deadline. The heartbeat is what keeps the wait visible instead of silent.
 * Every collaborator is injectable so the loop is testable without real time.
 */
export async function watch({
  probe,
  intervals = DEFAULT_INTERVALS_MS,
  probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  heartbeatMs = HEARTBEAT_INTERVAL_MS,
  log = (m) => console.log(m),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(),
  runProbeFn = runProbe,
}) {
  let prevStatus = null;
  let lastHeartbeat = -Infinity;

  for (let i = 0; ; i++) {
    const { code, out } = await runProbeFn(probe, probeTimeoutMs);
    const status = classifyExit(code);
    const t = now();

    if (shouldHeartbeat(prevStatus, status, t - lastHeartbeat, heartbeatMs)) {
      const tail = lastLine(out);
      log(`[kando-verify-wait] ${status} — probe: ${probe}${tail ? ` — ${tail}` : ''}`);
      lastHeartbeat = t;
    }
    prevStatus = status;

    if (status === 'green') return EXIT.green;
    if (status === 'red') return EXIT.red;
    if (status === 'malformed') {
      log(`[kando-verify-wait] MALFORMED PROBE — exit code ${code} is not 0/1/2. Probe: ${probe}`);
      return EXIT.malformed;
    }
    await sleep(nextDelay(i, intervals));
  }
}

/** CLI: --probe <cmd> [--interval-ms N] [--probe-timeout-ms N] */
export function parseArgs(argv) {
  const get = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const probe = get('--probe');
  if (!probe) throw new Error('usage: kando-verify-wait.mjs --probe <command> [--interval-ms N] [--probe-timeout-ms N]');
  const interval = get('--interval-ms');
  const timeout = get('--probe-timeout-ms');
  return {
    probe,
    intervals: interval ? [Number(interval)] : DEFAULT_INTERVALS_MS,
    probeTimeoutMs: timeout ? Number(timeout) : DEFAULT_PROBE_TIMEOUT_MS,
  };
}

// CLI entry — guarded so the module stays importable by the test suite.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await watch(parseArgs(process.argv.slice(2)));
  } catch (err) {
    console.log(`[kando-verify-wait] ${err.message}`);
    process.exitCode = EXIT.malformed;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/verifyWait.test.ts`
Expected: PASS, all tests.

- [ ] **Step 5: Add the subprocess integration test**

Append to `src/verifyWait.test.ts`:

```ts
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const assetPath = fileURLToPath(new URL('../assets/kando-verify-wait.mjs', import.meta.url));

const runCli = (args: string[]) =>
  new Promise<{ code: number | null; out: string }>((resolve) => {
    const c = spawn(process.execPath, [assetPath, ...args]);
    let out = '';
    c.stdout.on('data', (d) => { out += String(d); });
    c.stderr.on('data', (d) => { out += String(d); });
    c.on('close', (code) => resolve({ code, out }));
  });

describe('CLI (integration)', () => {
  it('exits 0 on a green probe', async () => {
    expect((await runCli(['--probe', 'exit 0'])).code).toBe(0);
  });

  it('exits 1 on a red probe', async () => {
    expect((await runCli(['--probe', 'exit 1'])).code).toBe(1);
  });

  it('exits 3 on a malformed probe', async () => {
    const r = await runCli(['--probe', 'exit 42']);
    expect(r.code).toBe(3);
    expect(r.out).toMatch(/MALFORMED PROBE/);
  });

  it('exits 3 when no probe is given', async () => {
    const r = await runCli([]);
    expect(r.code).toBe(3);
    expect(r.out).toMatch(/--probe/);
  });

  it('keeps waiting on a hanging probe, reporting it as pending', async () => {
    // A pending probe never terminates by design, so drive it far enough to see
    // the heartbeat, then kill it — that IS the behaviour under test.
    const c = spawn(process.execPath, [assetPath, '--probe', 'sleep 30', '--probe-timeout-ms', '150', '--interval-ms', '10']);
    const line = await new Promise<string>((resolve) => {
      c.stdout.on('data', (d) => resolve(String(d)));
    });
    c.kill('SIGKILL');
    expect(line).toMatch(/pending/);
  }, 10_000);
});
```

- [ ] **Step 6: Run the full suite**

Run: `npm test && npm run typecheck`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add assets/kando-verify-wait.mjs src/verifyWait.test.ts
git commit -m "feat(waiter): probe execution with timeout, watch loop, CLI entry"
```

---

### Task 3: Ship the asset via `init`

**Files:**
- Modify: `src/init.ts` (the hook-copy block, currently lines 152-160)
- Test: `src/init.test.ts:123` (the `init (integration)` case)

**Interfaces:**
- Consumes: `assets/kando-verify-wait.mjs` from Task 2.
- Produces: the asset at `.claude/hooks/kando-verify-wait.mjs` in every initialised repo. Task 4's `SKILL.md` invokes exactly that path.

- [ ] **Step 1: Write the failing test**

In `src/init.test.ts`, add one assertion after the existing hook assertion at line 134:

```ts
    expect(existsSync(join(dir, '.claude', 'hooks', 'kando-workflow.mjs'))).toBe(true);
    expect(existsSync(join(dir, '.claude', 'hooks', 'kando-verify-wait.mjs'))).toBe(true);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/init.test.ts`
Expected: FAIL — expected `false` to be `true`.

- [ ] **Step 3: Write minimal implementation**

In `src/init.ts`, inside `init()`, extend step 3. Replace:

```ts
  const hookDest = join(target, '.claude', 'hooks', 'kando-workflow.mjs');
  mkdirSync(dirname(hookDest), { recursive: true });
  copyFileSync(join(pkgRoot, '..', 'assets', 'kando-workflow.mjs'), hookDest);
```

with:

```ts
  const hooksDir = join(target, '.claude', 'hooks');
  mkdirSync(hooksDir, { recursive: true });
  const hookDest = join(hooksDir, 'kando-workflow.mjs');
  copyFileSync(join(pkgRoot, '..', 'assets', 'kando-workflow.mjs'), hookDest);
  // The loop's verification waiter. Not a hook — the coordinator runs it under
  // Monitor — but it lives here so `init` ships it with the hook it sits beside.
  copyFileSync(
    join(pkgRoot, '..', 'assets', 'kando-verify-wait.mjs'),
    join(hooksDir, 'kando-verify-wait.mjs'),
  );
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/init.test.ts`
Expected: PASS.

- [ ] **Step 5: Confirm the asset ships in the npm package**

Run: `npm pack --dry-run 2>&1 | grep kando-verify-wait`
Expected: one line listing `assets/kando-verify-wait.mjs`. (`package.json` already has `assets` in `files`, so no change is needed — this step only proves it.)

- [ ] **Step 6: Commit**

```bash
git add src/init.ts src/init.test.ts
git commit -m "feat(init): install kando-verify-wait.mjs alongside the workflow hook"
```

---

### Task 4: Rewrite the loop contract in `SKILL.md`

**Files:**
- Modify: `skills/kando-autonomous-loop/SKILL.md`

**Interfaces:**
- Consumes: the CLI from Task 2 (`node .claude/hooks/kando-verify-wait.mjs --probe '<cmd>'`, exits 0/1/3) at the path installed by Task 3.
- Produces: no code. This is the behavioural half of the change and is what actually stops the stalls.

No test harness covers `SKILL.md` prose. The gate is a careful read-through against the spec.

- [ ] **Step 1: Add probe composition to the coordinator preamble**

In `## Coordinator loop`, after the paragraph ending "**Safety counters are cumulative across the whole run** — all targets share one budget.", insert:

```markdown
**Before the first ticket, compose this repo's verification probe — once per run.** Read the repo and write a single shell command that answers "did commit `<sha>` end up green?" by its **exit code**: `0` green, `1` red, `2` still pending. Use `<sha>` as the placeholder; each worker's real sha is substituted at arming time. Work it out from what is actually in the repo — CI config, `Makefile`, `package.json` — rather than assuming a provider.

Illustrations, **not a menu** — a Buildkite or Jenkins repo gets a probe you write by reading it:
- GitHub Actions: `gh run list --commit <sha> --json status,conclusion --jq 'if length==0 then 2 elif (.[0].status!="completed") then 2 elif (.[0].conclusion=="success") then 0 else 1 end' ; exit $?`
- GitLab CI: `glab ci status --sha <sha>` wrapped so it maps to 0/1/2.
- No CI at all: the repo's own test command, e.g. `npm test` — it exits 0 or 1 and never reports pending, which the waiter handles without a special case.

**A probe must never return `2` when no run will ever exist.** A push filtered out by path rules or branch conditions triggers no pipeline, and a naive "no run found yet → pending" probe then polls forever. Give the probe its own grace period: once the sha is on the target branch and no run has appeared within it, return `0`.

If you cannot compose a probe for this repo, skip the wait entirely and fall back to the green-local-build gate described in the worker prompt.
```

- [ ] **Step 2: Make every short dispatch synchronous**

Replace coordinator step 3 (line 22) with:

```markdown
3. Dispatch ONE worker subagent (Agent tool, general-purpose, **`run_in_background: false`**) with the **worker prompt** below for the ticket `KEY-N`. It works TDD-first, commits **locally (no push)**, and reports `ready-for-review` (or `blocked`).
```

In step 4a (line 24), change "Dispatch a **fresh, independent reviewer subagent** (Agent tool, general-purpose)" to "Dispatch a **fresh, independent reviewer subagent** (Agent tool, general-purpose, **`run_in_background: false`**)".

- [ ] **Step 3: Give the coordinator the verification wait**

Replace coordinator step 5's `done` bullet (line 30-31, beginning "`done` → the ticket MUST be in the last column") with a new step 5 inserted before it:

```markdown
5. **When the worker reports `pushed`** (with its commit sha), arm the waiter and **end your turn**:
   - `Monitor` with `persistent: true`, command `node .claude/hooks/kando-verify-wait.mjs --probe '<the run's probe, with <sha> replaced by the worker's sha>'`.
   - Each heartbeat re-invokes you. While the status is `pending`, do nothing but stay visible — there is no deadline, by design.
   - Waiter exits **0** → SendMessage the worker `verified green, finish up`. It moves the ticket to the last column, records the deep link, and reports `done`.
   - Waiter exits **1** → **stop the whole loop** — a red pipeline is an infra failure. Surface the probe output.
   - Waiter exits **3** → **stop the whole loop** — the probe is malformed and cannot fix itself by being retried. Report the exit code and the probe. **Never treat this as green.**
   - No probe was composable for this repo → skip the wait; the worker's green local build is the gate.
```

Renumber the old steps 5 and 6 to 6 and 7. In the new step 6, replace the `done` bullet with:

```markdown
   - `done` → the ticket MUST be in the last column, carry the `claude` tag, and have a deep link in its `## 🤖 Claude — Done` section. You already observed the verification go green in step 5, so re-check the ticket state via `get_ticket` — do not re-derive the pipeline status.
```

and delete the `deploy-failed` bullet (line 32) — that outcome is now step 5's waiter-exit-1 path.

- [ ] **Step 4: Cut the open-ended watch out of the worker**

Replace worker prompt step 7 (line 48) with:

```markdown
> 7. **When the coordinator says `review passed — ship it`:** land the change on **`main`** — if you worked on a branch, merge it with `git merge --no-ff` (or commit directly on `main`), then **push `main`**. Running `/kando-loop` authorizes this — it is a standing pre-authorization to deploy; do NOT stop to ask, and do NOT leave the work on a branch or an open PR. Then report **`pushed`** with the commit sha and STOP. **Do not watch any pipeline yourself** — the coordinator owns that wait. (If the repo has no verification pipeline, the coordinator will tell you to finish immediately on your green local build.)
> 8. **When the coordinator says `verified green, finish up`:** move the ticket to the last column, record a **deep link** (the `main` commit URL, plus the pipeline run URL if there is one) in the Done section, and report **`done`**.
```

Renumber the old step 8 (`block it`) to step 9.

- [ ] **Step 5: Update the worker's report vocabulary**

Replace line 50 with:

```markdown
> Report exactly one word each turn — `ready-for-review`, `pushed`, `done`, or `blocked` — with a one-line reason. Never push before the coordinator says the review passed.
```

`deploy-failed` is gone from the worker's vocabulary: the worker no longer observes the pipeline, so it can no longer report on it.

- [ ] **Step 6: Add the rule that prevents regressions**

After the `## The `human-needed` bar is HIGH` section, add:

```markdown
## No silent waits

**No wait in this loop may depend on a single notification that might not arrive.** That is the failure mode this design exists to remove.

- Short waits — worker dispatch, reviewer dispatch, review round-trips — are **synchronous** (`run_in_background: false`). The coordinator is strictly sequential and needs each result before continuing, so backgrounding them buys nothing and makes a lost notification fatal.
- The one genuinely long wait — verification after a push — is a **heartbeat stream** via `Monitor`, never a blocking call. Never run a pipeline watch (`gh run watch` or any equivalent) in the foreground: it blocks with no heartbeat, and a foreground command is capped at 10 minutes anyway.
- A wait that produces no output is indistinguishable from a wait that died. If you are waiting, something must be emitting.
```

- [ ] **Step 7: Update the `## Never` list**

Replace the two `deploy` lines in `## Never` (lines 78 and 82) with:

```markdown
- **Never report `done` before the change is pushed to `main` AND the verification probe has gone green.** A pushed branch, an open PR, or a green branch-CI run is NOT done.
```

and

```markdown
- Never push a red build. Never mark `done` on a red or malformed verification. Never work a ticket assigned to a human. Never continue the loop after a red pipeline. Never lower the `human-needed` bar to skip hard work.
```

- [ ] **Step 8: Read the whole file back**

Run: `cat skills/kando-autonomous-loop/SKILL.md`

Check: step numbers run 1..N with no gaps in both the coordinator loop and the worker prompt; `deploy-failed` appears nowhere; `gh run watch` appears nowhere; the waiter path matches what Task 3 installs.

- [ ] **Step 9: Verify the suite still passes**

Run: `npm test && npm run typecheck`
Expected: green. (`src/init.test.ts` copies the skills tree, so a malformed file would surface here.)

- [ ] **Step 10: Commit**

```bash
git add skills/kando-autonomous-loop/SKILL.md
git commit -m "feat(loop): coordinator-owned verification wait, synchronous dispatch, no silent waits"
```

---

### Task 5: Document the change

**Files:**
- Modify: `README.md` (the `## Skills & commands` section)

**Interfaces:**
- Consumes: everything above.
- Produces: nothing consumed downstream.

- [ ] **Step 1: Extend the skills section**

In `README.md`, after the `## Skills & commands` paragraph, add:

```markdown
`/kando-loop` verifies each pushed change with a **probe command it composes by reading your repo** — GitHub Actions, GitLab CI, a `Makefile` target, or just your test suite. The probe reports green/red/pending through its exit code, and a background waiter (`.claude/hooks/kando-verify-wait.mjs`) polls it with a heartbeat so a slow pipeline is visible rather than a silent stall. There is no CI configuration to write.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: describe the loop's repo-agnostic verification probe"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| 1. The waiter — exit table, backoff, heartbeat, per-probe timeout, waiter exit codes, flags | 1, 2 |
| 2. Composing the probe (LLM's job), once per run, illustrations-not-menu, no-run-ever trap, fallback | 4 (steps 1, 3) |
| 3. Loop contract — `pushed`, coordinator-owned Monitor wait, synchronous dispatch, no-silent-wait rule, step-5 simplification | 4 (steps 2–7) |
| 4. Implementation shape — self-contained, exports internals, `import.meta.url` guard, no build step | 1, 2 |
| 5. Testing — pure, integration, init | 1, 2, 3 |

No gaps. The spec's "Open question for implementation" (whether a synchronous `Agent` dispatch has a hard cap) is answered by observation during Task 4's first real run, not by a code change — noted below.

**Placeholder scan:** none. Every code step carries runnable code; every `SKILL.md` step quotes the exact replacement prose.

**Type consistency:** `nextDelay`/`classifyExit`/`shouldHeartbeat`/`EXIT`/`runProbe`/`watch`/`parseArgs` are spelled identically in Tasks 1, 2 and their tests. The installed path `.claude/hooks/kando-verify-wait.mjs` is identical in Tasks 3 and 4. Probe codes (0/1/2/else) and waiter codes (0/1/3) are stated identically in the Global Constraints, Task 1's `EXIT`, Task 2's `watch`, and Task 4's step 3.

## Carry-forward

The spec's open question — whether a synchronous `Agent` dispatch has its own hard time cap — cannot be settled from the docs. If a long worker task is cut short after Task 4 ships, the fallback is background dispatch plus the same heartbeat treatment already built for verification. Nothing in Tasks 1–3 changes under that fallback; only `SKILL.md` step 2 would be revised.
