import { describe, it, expect } from 'vitest';
import { expiryStatus, expiryMessage } from './expiry.js';

const day = 86_400_000;
const saved = '2026-07-01T00:00:00.000Z';
const savedMs = Date.parse(saved);

describe('expiryStatus', () => {
  it('warns within 5 days of the 90-day expiry', () => {
    const s = expiryStatus(saved, savedMs + 86 * day)!; // 4 days left
    expect(s.daysLeft).toBe(4);
    expect(s.warn).toBe(true);
  });
  it('does not warn with >5 days left', () => {
    const s = expiryStatus(saved, savedMs + 10 * day)!;
    expect(s.warn).toBe(false);
  });
  it('returns null when savedAt is null or invalid', () => {
    expect(expiryStatus(null)).toBeNull();
    expect(expiryStatus('not-a-date')).toBeNull();
  });
});

describe('expiryMessage', () => {
  it('mentions login and the day count', () => {
    expect(expiryMessage(3)).toMatch(/3 day/);
    expect(expiryMessage(3)).toMatch(/kando-mcp login/);
  });
});
