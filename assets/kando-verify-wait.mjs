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
    child.stdout?.on('data', (d) => {
      out += String(d);
    });
    child.stderr?.on('data', (d) => {
      out += String(d);
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ code: 127, out: out + 'probe failed to start' });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({ code: 2, out: `${out}\n[probe exceeded ${timeoutMs}ms — counted as pending]` });
      } else {
        resolve({ code: code ?? 127, out });
      }
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
