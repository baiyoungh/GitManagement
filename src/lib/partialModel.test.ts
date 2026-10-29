import { describe, expect, it } from 'vitest';
import type { Hunk } from '../api/types';
import { fileState, hunkKeys, hunkState, lineIncluded, reconcile, setAll, toRequest, toggleHunk, toggleLine } from './partialModel';

// 旧：1..9；新：第 2 行修改、末尾新增 10、11
const OLD = '1\n2\n3\n4\n5\n6\n7\n8\n9\n';
const NEW = '1\nTWO\n3\n4\n5\n6\n7\n8\n9\n10\n11\n';
const h1: Hunk = { oldStart: 2, oldLines: 1, newStart: 2, newLines: 1 };
const h2: Hunk = { oldStart: 9, oldLines: 0, newStart: 10, newLines: 2 };
const hunks = [h1, h2];
const keys = hunkKeys(OLD, NEW, hunks);

describe('partialModel', () => {
  it('defaults to everything selected', () => {
    expect(fileState(undefined)).toBe('all');
    expect(hunkState(undefined, 0)).toBe('all');
  });

  it('keys are content based and unique', () => {
    expect(keys[0]).not.toBe(keys[1]);
    const dup = hunkKeys('a\nx\na\n', 'b\nx\nb\n', [
      { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 },
      { oldStart: 3, oldLines: 1, newStart: 3, newLines: 1 },
    ]);
    expect(dup[0]).not.toBe(dup[1]);
  });

  it('toggles hunks', () => {
    const s = toggleHunk(undefined, hunks, keys, 0);
    expect(hunkState(s, 0)).toBe('none');
    expect(fileState(s)).toBe('partial');
    expect(toRequest(s)).toEqual([{ oldStart: 9, oldLines: 0, newStart: 10, newLines: 2, removed: null, added: null }]);
    expect(fileState(toggleHunk(s, hunks, keys, 0))).toBe('all');
  });

  it('toggles single lines', () => {
    const s = toggleLine(undefined, hunks, keys, 1, 'n', 11);
    expect(hunkState(s, 1)).toBe('partial');
    expect(lineIncluded(s, 1, 'n', 11)).toBe(false);
    expect(lineIncluded(s, 1, 'n', 10)).toBe(true);
    expect(toRequest(s)[1]).toEqual({ oldStart: 9, oldLines: 0, newStart: 10, newLines: 2, removed: null, added: [10] });
    expect(hunkState(toggleHunk(s, hunks, keys, 1), 1)).toBe('all');
  });

  it('clicking a line in an excluded hunk selects only that line', () => {
    const s = toggleLine(toggleHunk(undefined, hunks, keys, 1), hunks, keys, 1, 'n', 10);
    expect(toRequest(s)[1]).toEqual({ oldStart: 9, oldLines: 0, newStart: 10, newLines: 2, removed: null, added: [10] });
  });

  it('all excluded → none, empty request', () => {
    const s = setAll(hunks, keys, false)!;
    expect(fileState(s)).toBe('none');
    expect(toRequest(s)).toEqual([]);
    expect(setAll(hunks, keys, true)).toBeUndefined();
  });

  it('exclusions follow a hunk whose line numbers shifted', () => {
    // 排除末尾新增的第 11 行，然后用户在文件开头插入一行
    const s = toggleLine(undefined, hunks, keys, 1, 'n', 11);
    const NEW2 = '0\n1\nTWO\n3\n4\n5\n6\n7\n8\n9\n10\n11\n';
    const hs2: Hunk[] = [
      { oldStart: 0, oldLines: 0, newStart: 1, newLines: 1 },
      { oldStart: 2, oldLines: 1, newStart: 3, newLines: 1 },
      { oldStart: 9, oldLines: 0, newStart: 11, newLines: 2 },
    ];
    const r = reconcile(s, hs2, hunkKeys(OLD, NEW2, hs2))!;
    expect(r.stale).toBeFalsy();
    expect(lineIncluded(r, 2, 'n', 12)).toBe(false);
    expect(lineIncluded(r, 2, 'n', 11)).toBe(true);
    expect(toRequest(r)).toEqual([
      { oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, removed: null, added: null },
      { oldStart: 2, oldLines: 1, newStart: 3, newLines: 1, removed: null, added: null },
      { oldStart: 9, oldLines: 0, newStart: 11, newLines: 2, removed: null, added: [11] },
    ]);
  });

  it('fails closed when an excluded hunk changed', () => {
    const s = toggleHunk(undefined, hunks, keys, 0);
    const NEW2 = '1\nTWO!\n3\n4\n5\n6\n7\n8\n9\n10\n11\n';
    const keys2 = hunkKeys(OLD, NEW2, hunks);
    const r = reconcile(s, hunks, keys2)!;
    expect(r.stale).toBe(true);
    // 变化后的块默认不提交，未变化的块保持原选择
    expect(hunkState(r, 0)).toBe('none');
    expect(hunkState(r, 1)).toBe('all');
    // 再次刷新不会丢失 stale 标记
    expect(reconcile(r, hunks, keys2)?.stale).toBe(true);
    // 无排除项的选择在 hunk 变化后回到"全选"
    const cleared = toggleHunk(toggleHunk(undefined, hunks, keys, 0), hunks, keys, 0);
    expect(fileState(reconcile(cleared, hunks, keys))).toBe('all');
    expect(reconcile(cleared, [h2], [keys[1]])).toBeUndefined();
  });
});
