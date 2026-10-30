import { describe, expect, it } from 'vitest';
import { widestLine } from './diffWidth';

describe('diff content measurement', () => {
  const measure = (text: string) => [...text].reduce((width, char) => width + (char === '中' ? 16 : 8), 0);
  it('includes long lines outside the initial virtual window', () => {
    expect(widestLine(`${'short\n'.repeat(300)}${'x'.repeat(1000)}`, measure, 64)).toBe(8000);
  });
  it('measures CJK, tab stops, CRLF and empty input', () => {
    expect(widestLine('中\tx\r\nsmall', measure, 64)).toBe(72);
    expect(widestLine('12345678\tx', measure, 64)).toBe(136);
    expect(widestLine(null, measure, 64)).toBe(0);
  });
});
