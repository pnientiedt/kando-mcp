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
export function shouldHeartbeat(
  prevStatus,
  status,
  msSinceLastHeartbeat,
  heartbeatMs = HEARTBEAT_INTERVAL_MS,
) {
  if (prevStatus !== status) return true;
  return msSinceLastHeartbeat >= heartbeatMs;
}
