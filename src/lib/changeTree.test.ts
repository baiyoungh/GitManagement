import { describe, expect, it } from 'vitest';
import type { FileChange } from '../api/types';
import { buildTree, checkState, defaultChecked, flatten, toggleAll } from './changeTree';

const f = (path: string, kind: FileChange['kind'] = 'modified', added = 1, removed = 0): FileChange => ({
  path,
  origPath: null,
  kind,
  indexStatus: '.',
  worktreeStatus: 'M',
  staged: false,
  unstaged: true,
  conflict: null,
  submodule: false,
  added,
  removed,
});

describe('changeTree', () => {
  it('builds a directory tree and compresses single-child chains', () => {
    const tree = buildTree('g', [f('src/app/a.ts'), f('src/app/b.ts'), f('README.md')], false);
    expect(tree.map((n) => n.name)).toEqual(['src/app', 'README.md']);
    expect(tree[0].files).toEqual(['src/app/a.ts', 'src/app/b.ts']);
    expect(tree[0].added).toBe(2);
  });

  it('handles 中文 and spaces in paths', () => {
    const tree = buildTree('g', [f('中文 目录/a b.ts'), f('中文 目录/c.ts')], false);
    expect(tree[0].name).toBe('中文 目录');
    expect(tree[0].children.map((c) => c.name)).toEqual(['a b.ts', 'c.ts']);
  });

  it('flat mode lists full paths', () => {
    const tree = buildTree('g', [f('b/x.ts'), f('a.ts')], true);
    expect(tree.map((n) => n.name)).toEqual(['a.ts', 'b/x.ts']);
  });

  it('computes tri-state', () => {
    const set = new Set(['a', 'b']);
    expect(checkState(['a', 'b'], (p) => set.has(p))).toBe('checked');
    expect(checkState(['a', 'c'], (p) => set.has(p))).toBe('partial');
    expect(checkState(['c'], (p) => set.has(p))).toBe('unchecked');
    expect(checkState([], () => true)).toBe('unchecked');
  });

  it('toggles a directory', () => {
    expect(toggleAll(['a', 'b'], 'partial')).toEqual({ a: true, b: true });
    expect(toggleAll(['a', 'b'], 'checked')).toEqual({ a: false, b: false });
  });

  it('defaults: tracked checked, untracked unchecked', () => {
    expect(defaultChecked(f('a', 'modified'))).toBe(true);
    expect(defaultChecked(f('a', 'deleted'))).toBe(true);
    expect(defaultChecked(f('a', 'untracked'))).toBe(false);
    expect(defaultChecked(f('a', 'conflicted'))).toBe(false);
  });

  it('flattens only expanded directories', () => {
    const tree = buildTree('g', [f('src/a.ts'), f('lib/b.ts')], false);
    const rows = flatten(tree, (k) => k === 'g:src/');
    expect(rows.map((r) => r.node.name)).toEqual(['lib', 'src', 'a.ts']);
  });
});
