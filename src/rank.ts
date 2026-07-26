// Fractional-index ranks over the ordered alphabet 0-9 A-Z a-z (base 62).
// Copied verbatim from infra/lambda/api/rank.ts (also copied to web/src/lib/rank.ts)
// so a rank the MCP server computes for a reordered ticket sorts identically to
// one the resolver or the board UI computes. web/src/__tests__/rank.sync.test.ts
// asserts all three copies agree — keep them in sync.
const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const BASE = DIGITS.length;

function val(ch: string): number {
  return DIGITS.indexOf(ch);
}

/** Returns a rank string strictly between a and b (null = open bound). */
export function rankBetween(a: string | null, b: string | null): string {
  const lo = a ?? '';
  const hi = b ?? '';
  let result = '';
  let i = 0;
  // Walk positions building the smallest string strictly between lo and hi.
  for (;;) {
    const loDigit = i < lo.length ? val(lo[i]) : 0;
    const hiDigit = i < hi.length ? val(hi[i]) : BASE;
    if (loDigit === hiDigit) {
      result += DIGITS[loDigit];
      i++;
      continue;
    }
    const mid = Math.floor((loDigit + hiDigit) / 2);
    if (mid > loDigit) {
      result += DIGITS[mid];
      return result;
    }
    // No integer gap at this position: take lo's digit and descend.
    result += DIGITS[loDigit];
    i++;
  }
}
