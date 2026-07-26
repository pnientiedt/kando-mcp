import { describe, it, expect, vi } from 'vitest';
import { runLogout } from './logout.js';

describe('runLogout', () => {
  it('deletes stored creds and confirms', () => {
    const del = vi.fn();
    const out: string[] = [];
    runLogout({ del, out: (s) => out.push(s) });
    expect(del).toHaveBeenCalled();
    expect(out.join('')).toMatch(/logged out/i);
  });
});
