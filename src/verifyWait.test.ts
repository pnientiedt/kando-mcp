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
