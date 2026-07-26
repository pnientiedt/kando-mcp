import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Loaded through a runtime-constructed specifier: tsconfig includes only `src`
// and has allowJs off, so a static import of the untyped .mjs would break
// `tsc --noEmit`. The variable specifier keeps it opaque to tsc.
const assetUrl = new URL('../assets/kando-verify-wait.mjs', import.meta.url).href;
const w: any = await import(/* @vite-ignore */ assetUrl);

describe('runWatch', () => {
  // A watch BLOCKS for as long as the work takes — that is its whole job. It
  // must not carry runProbe's short per-invocation timeout. Getting this wrong
  // is what made a no-CI repo unresolvable in 0.2.0: `npm test` was run as a
  // probe, killed at 60s, reported `pending`, and re-run forever, so a suite
  // that PASSED never produced a verdict.
  it('waits out a slow command and returns its verdict', async () => {
    const started = Date.now();
    const r = await w.runWatch('node -e "setTimeout(function(){process.exit(0)}, 1200)"').done;
    expect(r.verdict).toBe('green');
    expect(Date.now() - started).toBeGreaterThan(1000); // it really waited
  });

  it('maps a failing command to red', async () => {
    expect((await w.runWatch('node -e "process.exit(1)"').done).verdict).toBe('red');
  });

  // A watch that dies for any other reason must NOT be authoritative — it can
  // only ever make things faster, never wrong. Anything but 0/1 means
  // "unavailable", and the caller falls back to polling.
  it('reports any other exit as unavailable, never as a verdict', async () => {
    expect((await w.runWatch('node -e "process.exit(42)"').done).verdict).toBe('unavailable');
    expect((await w.runWatch('definitely-not-a-real-command-xyz').done).verdict).toBe('unavailable');
  });

  // The handle must be usable BEFORE the watch finishes — that is the whole
  // point of returning it synchronously rather than after resolution.
  it('exposes a kill handle while still running', async () => {
    const h = w.runWatch('node -e "setTimeout(function(){process.exit(0)}, 30000)"');
    const started = Date.now();
    h.kill();
    const r = await h.done;
    expect(r.verdict).toBe('unavailable'); // killed, so not a verdict
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

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

// Probes are run through a shell, so they must be written in something BOTH
// sh and cmd.exe understand. `echo 0; exit 2` is not that: cmd has no `;`, so
// it echoes the literal string and exits 0. Driving node is portable, and the
// grandchild it creates under `shell: true` is exactly what killTree must reap.
const hangProbe = (ms: number) => `node -e "setTimeout(function(){}, ${ms})"`;
const printThenExit = (printed: number, code: number) =>
  `node -e "console.log(${printed}); process.exit(${code})"`;

describe('watch — watch/poll composition', () => {
  const base = (over: any = {}) => ({
    intervals: [1],
    probeTimeoutMs: 10,
    heartbeatMs: 300_000,
    log: () => {},
    sleep: async () => {},
    now: () => 0,
    ...over,
  });
  const fakeWatch = (verdict: string, out = '') => () => ({
    done: Promise.resolve({ verdict, out }),
    kill: () => {},
  });
  const probeReturning = (codes: number[]) => {
    let i = 0;
    return async () => ({ code: codes[Math.min(i++, codes.length - 1)], out: '' });
  };

  it('requires at least one of watch or probe', async () => {
    await expect(w.watch(base())).rejects.toThrow(/--watch|--probe/);
  });

  it('watch alone is enough — no polling involved', async () => {
    const code = await w.watch(base({ watchCmd: 'x', runWatchFn: fakeWatch('green') }));
    expect(code).toBe(0);
  });

  it('watch alone that goes unavailable halts loudly rather than guessing', async () => {
    const logs: string[] = [];
    const code = await w.watch(
      base({ watchCmd: 'x', runWatchFn: fakeWatch('unavailable'), log: (m: string) => logs.push(m) }),
    );
    expect(code).toBe(3);
    expect(logs.join('\n')).toMatch(/UNAVAILABLE/i);
  });

  it('watch wins the race when both are present', async () => {
    const code = await w.watch(
      base({
        watchCmd: 'x',
        probe: 'p',
        runWatchFn: fakeWatch('red'),
        runProbeFn: probeReturning([2]), // would poll forever
      }),
    );
    expect(code).toBe(1);
  });

  it('falls back to the poll when the watch goes unavailable', async () => {
    const code = await w.watch(
      base({
        watchCmd: 'x',
        probe: 'p',
        runWatchFn: fakeWatch('unavailable'),
        runProbeFn: probeReturning([2, 2, 0]),
      }),
    );
    expect(code).toBe(0); // the poll decided it
  });

  it('kills the watch when the poll wins', async () => {
    let killed = false;
    const code = await w.watch(
      base({
        watchCmd: 'x',
        probe: 'p',
        runWatchFn: () => ({ done: new Promise(() => {}), kill: () => (killed = true) }),
        runProbeFn: probeReturning([0]),
      }),
    );
    expect(code).toBe(0);
    expect(killed).toBe(true);
  });
});

describe('runProbe', () => {
  it('reports a real command exit code', async () => {
    expect((await w.runProbe(printThenExit(9, 2), 5000)).code).toBe(2);
  });

  // Regression guard: the original implementation waited for `close` after
  // killing the shell, but with `shell: true` the real probe is a GRANDCHILD
  // that survives and holds the stdout pipe open. That made this resolve only
  // once `sleep` finished on its own — i.e. a hanging probe wedged the poller
  // on Linux and Windows, while passing on macOS where the shell execs.
  // Asserting the ELAPSED TIME is what makes the bug visible; the exit code
  // alone was green on macOS throughout.
  it('gives up on an overrunning probe promptly, and calls it pending', async () => {
    const started = Date.now();
    const r = await w.runProbe(hangProbe(5000), 150);
    const elapsed = Date.now() - started;
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/exceeded/);
    expect(elapsed).toBeLessThan(2000); // nowhere near the probe's own 5s
  });

  // The trap that bit the documented `gh` probe: `gh --jq` PRINTS the verdict
  // and exits 0 because gh itself succeeded, so a probe ending `; exit $?`
  // reports green for a pending run. Stdout is never the verdict.
  // The macOS shell exec-optimises a simple command, so `hangProbe` alone has
  // no grandchild there and the bug stayed invisible locally. This probe forces
  // a genuine grandchild on EVERY platform, so the tree-kill path is covered
  // even on the machine where the original bug could not reproduce.
  it('gives up promptly even when the probe spawned a grandchild', async () => {
    const nested =
      `node -e "require('child_process').spawn(process.execPath,` +
      `['-e','setTimeout(function(){},5000)'],{stdio:'inherit'}); ` +
      `setTimeout(function(){},5000)"`;
    const started = Date.now();
    const r = await w.runProbe(nested, 200);
    expect(r.code).toBe(2);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('reads the exit code, never the printed output', async () => {
    const r = await w.runProbe(printThenExit(0, 2), 5000);
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

  it('reads a watch command', () => {
    const a = w.parseArgs(['--watch', 'gh run watch 7 --exit-status']);
    expect(a.watchCmd).toBe('gh run watch 7 --exit-status');
    expect(a.probe).toBeUndefined();
  });

  it('accepts both', () => {
    const a = w.parseArgs(['--watch', 'W', '--probe', 'P']);
    expect(a.watchCmd).toBe('W');
    expect(a.probe).toBe('P');
  });

  it('rejects having neither', () => {
    expect(() => w.parseArgs([])).toThrow(/--watch|--probe/);
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
    expect((await runCli(['--probe', printThenExit(1, 0)])).code).toBe(0);
  });

  it('exits 1 on a red probe', async () => {
    expect((await runCli(['--probe', printThenExit(1, 1)])).code).toBe(1);
  });

  it('exits 3 on a malformed probe', async () => {
    const r = await runCli(['--probe', printThenExit(1, 42)]);
    expect(r.code).toBe(3);
    expect(r.out).toMatch(/MALFORMED PROBE/);
  });

  it('exits 3 when neither watch nor probe is given', async () => {
    const r = await runCli([]);
    expect(r.code).toBe(3);
    expect(r.out).toMatch(/--watch|--probe/);
  });

  // The 0.2.0 regression, end to end: a no-CI repo whose suite takes longer
  // than the probe timeout. As a --probe this was killed, called `pending`,
  // and re-run forever; as a --watch it simply runs to completion.
  it('resolves a slow-but-passing suite given as a watch', async () => {
    const started = Date.now();
    const r = await runCli([
      '--watch',
      'node -e "setTimeout(function(){process.exit(0)}, 1500)"',
      '--probe-timeout-ms',
      '200',
    ]);
    expect(r.code).toBe(0);
    expect(Date.now() - started).toBeGreaterThan(1300); // it waited, not killed
  }, 15_000);

  it('exits 3 when a watch-only run cannot produce a verdict', async () => {
    const r = await runCli(['--watch', 'node -e "process.exit(42)"']);
    expect(r.code).toBe(3);
    expect(r.out).toMatch(/UNAVAILABLE/i);
  });

  it('keeps waiting on a hanging probe, reporting it as pending', async () => {
    // A pending probe never terminates by design, so drive it far enough to see
    // the heartbeat, then kill it — that IS the behaviour under test.
    const c = spawn(process.execPath, [
      assetPath,
      '--probe',
      hangProbe(5000),
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
