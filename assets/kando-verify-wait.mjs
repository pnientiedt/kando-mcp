// Kando loop verification waiter — polls a probe command until it reaches a
// terminal state. Deliberately knows NOTHING about any CI system: the caller
// composes the probe by reading the repo. Self-contained (no imports beyond
// node builtins) because `init` copies this file into a target repo where
// nothing else is installed.
//
// Probe contract (exit code is the whole interface):
//   0 = green, 1 = red, 2 = still pending, anything else = malformed probe.

import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

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
export function shouldHeartbeat(
  prevStatus,
  status,
  msSinceLastHeartbeat,
  heartbeatMs = HEARTBEAT_INTERVAL_MS,
) {
  if (prevStatus !== status) return true;
  return msSinceLastHeartbeat >= heartbeatMs;
}

/**
 * Kill a probe and everything it spawned. `shell: true` means the probe's real
 * work is a GRANDCHILD of the shell we spawned, so killing only the shell
 * leaves it running — still holding the stdout pipe open, so `close` never
 * fires. On POSIX the child leads its own process group and the negative pid
 * kills the whole group; Windows has no equivalent, which is why the caller
 * must not depend on this succeeding.
 */
function killTree(child) {
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

/**
 * Run the probe once. A probe that overruns `timeoutMs` is killed and reported
 * as pending (code 2) — a hanging `gh`/`curl` must never wedge the poller, and
 * must never be mistaken for a verdict.
 */
export function runProbe(probe, timeoutMs, spawnFn = spawn) {
  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    let child;
    const finish = (code, extra = '') => {
      if (settled) return;
      settled = true;
      resolve({ code, out: out + extra });
    };
    try {
      // `detached` so the probe leads its own process group — see killTree.
      child = spawnFn(probe, { shell: true, detached: process.platform !== 'win32' });
    } catch {
      finish(127, 'probe failed to start');
      return;
    }
    const timer = setTimeout(() => {
      killTree(child);
      // Resolve NOW rather than waiting for `close`. If the kill fails to reap
      // a grandchild the poller must still move on: the whole point of this
      // timeout is that no probe can ever wedge the loop, on any platform.
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref?.();
      finish(2, `\n[probe exceeded ${timeoutMs}ms — counted as pending]`);
    }, timeoutMs);
    child.stdout?.on('data', (d) => {
      out += String(d);
    });
    child.stderr?.on('data', (d) => {
      out += String(d);
    });
    child.on('error', () => {
      clearTimeout(timer);
      finish(127, 'probe failed to start');
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish(code ?? 127);
    });
  });
}

/**
 * Run a BLOCKING watch: one invocation that returns when the outcome is known
 * (`gh run watch`, `glab ci status --wait`, or simply the repo's test suite).
 *
 * Deliberately has NO per-invocation timeout. A watch is *supposed* to block
 * for as long as the work takes — that is the opposite of `runProbe`, which is
 * a status query and must not hang. Conflating the two is what made a no-CI
 * repo unresolvable in 0.2.0: `npm test` ran as a probe, got killed at 60s,
 * was reported `pending`, and re-ran forever, so a passing suite never
 * produced a verdict.
 *
 * Only 0 and 1 are verdicts. Anything else — a crashed CLI, a dropped network,
 * a command that does not exist — is `unavailable`, and the caller falls back
 * to polling. A watch can make the wait faster; it can never make it wrong.
 *
 * Returns `{ done, kill }` synchronously — `kill` must be usable while the
 * watch is still running, so the poll can reap it on winning the race.
 */
export function runWatch(watchCmd, spawnFn = spawn) {
  let child;
  const done = new Promise((resolve) => {
    let out = '';
    let settled = false;
    const finish = (verdict, extra = '') => {
      if (settled) return;
      settled = true;
      resolve({ verdict, out: out + extra });
    };
    try {
      child = spawnFn(watchCmd, { shell: true, detached: process.platform !== 'win32' });
    } catch {
      finish('unavailable', 'watch failed to start');
      return;
    }
    child.stdout?.on('data', (d) => {
      out += String(d);
    });
    child.stderr?.on('data', (d) => {
      out += String(d);
    });
    child.on('error', () => finish('unavailable', out + 'watch failed to start'));
    child.on('close', (code) => {
      if (code === 0) finish('green');
      else if (code === 1) finish('red');
      else finish('unavailable', `\n[watch exited ${code} — not a verdict, falling back to polling]`);
    });
  });
  return { done, kill: () => child && killTree(child) };
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
  watchCmd,
  intervals = DEFAULT_INTERVALS_MS,
  probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  heartbeatMs = HEARTBEAT_INTERVAL_MS,
  log = (m) => console.log(m),
  sleep,
  now = () => Date.now(),
  runProbeFn = runProbe,
  runWatchFn = runWatch,
}) {
  if (!watchCmd && !probe) {
    throw new Error('nothing to wait on: pass --watch, --probe, or both');
  }

  // The poll's sleep is tracked so a won race can cancel it. An outstanding
  // 5-minute timer would otherwise hold the process open long after the
  // verdict is in.
  let pollTimer = null;
  const doSleep = sleep ?? ((ms) => new Promise((r) => (pollTimer = setTimeout(r, ms))));
  let stopped = false;
  const stopPolling = () => {
    stopped = true;
    if (pollTimer) clearTimeout(pollTimer);
  };

  // --- watch only: run it once and take its answer. No polling exists here
  // (a local test suite has no status to query), so an unavailable watch is
  // unresolvable and must halt loudly rather than be guessed at.
  if (watchCmd && !probe) {
    const r = await runWatchFn(watchCmd).done;
    const tail = lastLine(r.out);
    log(`[kando-verify-wait] ${r.verdict} — watch: ${watchCmd}${tail ? ` — ${tail}` : ''}`);
    if (r.verdict === 'green') return EXIT.green;
    if (r.verdict === 'red') return EXIT.red;
    log(`[kando-verify-wait] WATCH UNAVAILABLE and no --probe to fall back to. Cannot determine a verdict.`);
    return EXIT.malformed;
  }

  let prevStatus = null;
  let lastHeartbeat = -Infinity;

  const pollLoop = async () => {
    for (let i = 0; !stopped; i++) {
      const { code, out } = await runProbeFn(probe, probeTimeoutMs);
      if (stopped) break;
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
      await doSleep(nextDelay(i, intervals));
    }
    return null;
  };

  // --- poll only
  if (!watchCmd) return pollLoop();

  // --- both: the watch is primary, the poll is the safety net. First verdict
  // wins; the loser is reaped. An unavailable watch never settles the race —
  // it just steps aside and lets the poll decide, which is the entire reason
  // the watch can only ever make this faster, never wrong.
  const handle = runWatchFn(watchCmd);
  const fromWatch = handle.done.then(async (r) => {
    const tail = lastLine(r.out);
    if (r.verdict === 'unavailable') {
      log(`[kando-verify-wait] watch unavailable — polling on${tail ? `: ${tail}` : ''}`);
      return new Promise(() => {}); // never settles; the poll decides
    }
    if (r.verdict === 'green') {
      log(`[kando-verify-wait] green — watch: ${watchCmd}${tail ? ` — ${tail}` : ''}`);
      return EXIT.green;
    }
    // A red from the watch halts the ENTIRE run, so it is worth one cheap
    // confirmation. It also has to be: cmd.exe collapses "command not found"
    // into exit 1, indistinguishable from a genuine failure, so on Windows a
    // missing `gh` would otherwise report a red pipeline instead of quietly
    // falling back to the poll. Confirming keeps the promise that a watch can
    // only ever make this faster, never wrong.
    const { code } = await runProbeFn(probe, probeTimeoutMs);
    const confirmed = classifyExit(code);
    if (confirmed === 'red') {
      log(`[kando-verify-wait] red — watch: ${watchCmd}${tail ? ` — ${tail}` : ''} (confirmed by probe)`);
      return EXIT.red;
    }
    if (confirmed === 'green') {
      log(`[kando-verify-wait] green — probe overrode a red watch; trusting the probe`);
      return EXIT.green;
    }
    log(`[kando-verify-wait] watch said red but the probe says ${confirmed} — distrusting the watch, polling on`);
    return new Promise(() => {});
  });

  const code = await Promise.race([fromWatch, pollLoop()]);
  stopPolling();
  handle.kill();
  return code;
}

/**
 * CLI: [--watch <cmd>] [--probe <cmd>] [--interval-ms N] [--probe-timeout-ms N]
 *
 * At least one of --watch / --probe. `--watch` blocks until the outcome is
 * known and is the primary signal; `--probe` is polled and is the safety net.
 */
export function parseArgs(argv) {
  const get = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const probe = get('--probe');
  const watchCmd = get('--watch');
  if (!probe && !watchCmd) {
    throw new Error(
      'usage: kando-verify-wait.mjs [--watch <command>] [--probe <command>] ' +
        '[--interval-ms N] [--probe-timeout-ms N] — at least one of --watch / --probe',
    );
  }
  const interval = get('--interval-ms');
  const timeout = get('--probe-timeout-ms');
  return {
    probe,
    watchCmd,
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
