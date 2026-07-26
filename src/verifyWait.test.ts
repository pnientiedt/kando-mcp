import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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
        sleep: async (ms: number) => {
          clock += ms;
        },
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

  // The trap that bit the documented `gh` probe: `gh --jq` PRINTS the verdict
  // and exits 0 because gh itself succeeded, so a probe ending `; exit $?`
  // reports green for a pending run. Stdout is never the verdict.
  it('reads the exit code, never the printed output', async () => {
    const r = await w.runProbe('echo 0; exit 2', 5000);
    expect(r.code).toBe(2);
    expect(w.classifyExit(r.code)).toBe('pending');
  });
});

describe('parseArgs', () => {
  it('reads the probe and the timing overrides', () => {
    const a = w.parseArgs([
      '--probe',
      'gh run view 1',
      '--interval-ms',
      '50',
      '--probe-timeout-ms',
      '99',
    ]);
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

const assetPath = fileURLToPath(new URL('../assets/kando-verify-wait.mjs', import.meta.url));

const runCli = (args: string[]) =>
  new Promise<{ code: number | null; out: string }>((resolve) => {
    const c = spawn(process.execPath, [assetPath, ...args]);
    let out = '';
    c.stdout.on('data', (d) => {
      out += String(d);
    });
    c.stderr.on('data', (d) => {
      out += String(d);
    });
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
    const c = spawn(process.execPath, [
      assetPath,
      '--probe',
      'sleep 30',
      '--probe-timeout-ms',
      '150',
      '--interval-ms',
      '10',
    ]);
    const line = await new Promise<string>((resolve) => {
      c.stdout.on('data', (d) => resolve(String(d)));
    });
    c.kill('SIGKILL');
    expect(line).toMatch(/pending/);
  }, 10_000);
});
