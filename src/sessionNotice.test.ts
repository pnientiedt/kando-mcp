import { describe, it, expect } from 'vitest';
import { makeOnceNotice } from './sessionNotice.js';

describe('makeOnceNotice', () => {
  it('prepends a text block to the first result only', () => {
    const decorate = makeOnceNotice('⚠️ heads up');
    const r1 = decorate({ content: [{ type: 'text', text: 'a' }] });
    expect(r1.content[0].text).toBe('⚠️ heads up');
    expect(r1.content[1].text).toBe('a');
    const r2 = decorate({ content: [{ type: 'text', text: 'b' }] });
    expect(r2.content[0].text).toBe('b');
  });

  it('is a pass-through when text is null', () => {
    const decorate = makeOnceNotice(null);
    const r = { content: [{ type: 'text', text: 'x' }] };
    expect(decorate(r)).toBe(r);
  });
});
