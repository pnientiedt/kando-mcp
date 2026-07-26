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
  if (!probe) {
    throw new Error(
      'usage: kando-verify-wait.mjs --probe <command> [--interval-ms N] [--probe-timeout-ms N]',
    );
  }
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
