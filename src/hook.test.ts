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
  const lines = GATE_TEXT.split('\n');
  // Guard on backtick-free lines: the raw asset escapes backticks (\`) while the
  // GATE_TEXT runtime value has literal ones, so lines with backticks won't
  // string-match. These two frame the gate body and catch any drift.
  expect(asset).toContain(lines[1]); // "If this task corresponds to a Kando ticket KEY-N, …"
  expect(asset).toContain(lines[lines.length - 1]); // "A skill loaded for a previous ticket …"
});
