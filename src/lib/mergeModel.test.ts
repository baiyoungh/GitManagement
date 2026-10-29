import { describe, expect, it } from 'vitest';
import type { MergeData } from '../api/types';
import { acceptAll, applyNonConflicting, applySide, buildResult, counts, createModel, ignoreBlock, joinLines } from './mergeModel';

// base:   x / push(remote) / y / z
// ours:   X / push(remote, a) / y / z
// theirs: x / push(remote, b) / y / Z
const data: MergeData = {
  path: 'a.ts',
  base: 'x\npush(remote)\ny\nz\n',
  ours: 'X\npush(remote, a)\ny\nz\n',
  theirs: 'x\npush(remote, b)\ny\nZ\n',
  eol: '\n',
  worktreeEdited: false,
  blocks: [
    { kind: 'conflict', base: { start: 0, end: 2 }, ours: { start: 0, end: 2 }, theirs: { start: 0, end: 2 } },
    { kind: 'unchanged', base: { start: 2, end: 3 }, ours: { start: 2, end: 3 }, theirs: { start: 2, end: 3 } },
    { kind: 'theirs', base: { start: 3, end: 4 }, ours: { start: 3, end: 4 }, theirs: { start: 3, end: 4 } },
  ],
};

describe('mergeModel', () => {
  it('starts from base', () => {
    const m = createModel(data);
    expect(buildResult(m).lines).toEqual(['x', 'push(remote)', 'y', 'z']);
    expect(counts(m)).toEqual({ conflicts: 1, changes: 1 });
  });

  it('applies non-conflicting changes in one step', () => {
    const m = applyNonConflicting(createModel(data));
    expect(buildResult(m).lines).toEqual(['x', 'push(remote)', 'y', 'Z']);
    expect(counts(m)).toEqual({ conflicts: 1, changes: 0 });
  });

  it('applies both sides of a conflict left then right', () => {
    let m = applySide(createModel(data), 0, 'ours');
    expect(counts(m).conflicts).toBe(1);
    m = applySide(m, 0, 'theirs');
    expect(counts(m).conflicts).toBe(0);
    expect(buildResult(m).lines.slice(0, 4)).toEqual(['X', 'push(remote, a)', 'x', 'push(remote, b)']);
  });

  it('apply one side then ignore the other', () => {
    let m = applySide(createModel(data), 0, 'theirs');
    m = ignoreBlock(m, 0);
    expect(counts(m).conflicts).toBe(0);
    expect(buildResult(m).lines[1]).toBe('push(remote, b)');
  });

  it('accept all left', () => {
    const m = acceptAll(createModel(data), 'ours');
    expect(buildResult(m).lines).toEqual(['X', 'push(remote, a)', 'y', 'z']);
    expect(counts(m)).toEqual({ conflicts: 0, changes: 0 });
  });

  it('records block start lines in result', () => {
    const m = applySide(applySide(createModel(data), 0, 'ours'), 0, 'theirs');
    expect(buildResult(m).starts).toEqual([0, 4, 5]);
  });

  it('joins with eol', () => {
    expect(joinLines(['a', 'b'], '\r\n')).toBe('a\r\nb\r\n');
    expect(joinLines([], '\n')).toBe('');
  });
});
