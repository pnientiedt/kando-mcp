import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { shouldReanchor, GATE_TEXT } from './hookLogic.js';

describe('shouldReanchor', () => {
  it('matches a ticket key or the word kando', () => {
    expect(shouldReanchor('work on TSK-42')).toBe(true);
    expect(shouldReanchor('open the kando board')).toBe(true);
    expect(shouldReanchor('unrelated prompt')).toBe(false);
  });
});

it('the shipped hook asset embeds the gate text', () => {
  const asset = readFileSync(new URL('../assets/kando-workflow.mjs', import.meta.url), 'utf8');
  // EVERY backtick-free line, not just the framing pair. Checking only the first
  // and last let the whole middle of the gate — the actual instructions — drift
  // out of sync unnoticed when the body-append steps became comment steps.
  // Lines containing backticks are skipped because the raw asset escapes them
  // (\`) while the GATE_TEXT runtime value has literal ones.
  const guarded = GATE_TEXT.split('\n').filter((l) => !l.includes('`'));
  expect(guarded.length).toBeGreaterThan(4);
  for (const line of guarded) expect(asset).toContain(line);
});
