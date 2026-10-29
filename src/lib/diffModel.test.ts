import { describe, expect, it } from 'vitest';
import { buildSideBySide, buildUnified, inlineRange, revertHunk, splitLines } from './diffModel';

describe('diffModel', () => {
  const oldText = 'a\nb\nc\nd\n';
  const newText = 'a\nB\nc\nd\ne\n';
  // git diff -U0: @@ -2 +2 @@ (b→B), @@ -4,0 +5 @@ (+e)
  const hunks = [
    { oldStart: 2, oldLines: 1, newStart: 2, newLines: 1 },
    { oldStart: 4, oldLines: 0, newStart: 5, newLines: 1 },
  ];

  it('splits lines and strips CR', () => {
    expect(splitLines('x\r\ny\r\n')).toEqual(['x', 'y']);
    expect(splitLines('x')).toEqual(['x']);
    expect(splitLines('')).toEqual([]);
  });

  it('builds side-by-side rows', () => {
    const rows = buildSideBySide(oldText, newText, hunks, false);
    const lines = rows.filter((r) => r.kind === 'line');
    expect(lines).toHaveLength(5);
    const second = lines[1];
    expect(second.kind === 'line' && second.left.type).toBe('changed');
    const last = lines[4];
    expect(last.kind === 'line' && last.left.type).toBe('empty');
    expect(last.kind === 'line' && last.right.text).toBe('e');
  });

  it('builds unified rows', () => {
    const rows = buildUnified(oldText, newText, hunks, false);
    const types = rows.map((r) => (r.kind === 'line' ? r.line.type : 'collapsed'));
    expect(types).toEqual(['context', 'removed', 'added', 'context', 'context', 'added']);
  });

  it('collapses long unchanged runs', () => {
    const big = Array.from({ length: 30 }, (_, i) => `l${i}`).join('\n') + '\n';
    const changed = big.replace('l15\n', 'X\n');
    const rows = buildSideBySide(big, changed, [{ oldStart: 16, oldLines: 1, newStart: 16, newLines: 1 }], true);
    expect(rows.filter((r) => r.kind === 'collapsed')).toHaveLength(2);
  });

  it('reverts a single hunk', () => {
    expect(revertHunk(oldText, newText, hunks[0])).toBe('a\nb\nc\nd\ne\n');
    expect(revertHunk(oldText, newText, hunks[1])).toBe('a\nB\nc\nd\n');
  });

  it('reverts a pure deletion hunk', () => {
    // 删除了第 2 行 b：@@ -2 +1,0 @@
    expect(revertHunk('a\nb\nc\n', 'a\nc\n', { oldStart: 2, oldLines: 1, newStart: 1, newLines: 0 })).toBe('a\nb\nc\n');
  });

  it('keeps CRLF line endings', () => {
    expect(revertHunk('a\r\nb\r\n', 'a\r\nX\r\n', { oldStart: 2, oldLines: 1, newStart: 2, newLines: 1 })).toBe('a\r\nb\r\n');
  });

  it('computes inline range', () => {
    expect(inlineRange('push(remote)', 'push(remote, branch)')).toEqual({ prefix: 11, suffixA: 11, suffixB: 19 });
  });
});
