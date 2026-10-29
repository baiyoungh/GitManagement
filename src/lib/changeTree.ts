// 变更树与三态勾选（C-01、C-02；specs/04 第 1 节）。纯函数，便于单测。
import type { FileChange } from '../api/types';

export type CheckState = 'checked' | 'unchecked' | 'partial';

export interface TreeNode {
  /** 唯一 key：分组前缀 + 路径 */
  key: string;
  name: string;
  /** 目录节点为目录路径；文件节点为文件路径 */
  path: string;
  isDir: boolean;
  file?: FileChange;
  children: TreeNode[];
  /** 子树内的文件路径 */
  files: string[];
  added: number;
  removed: number;
}

export interface FlatRow {
  node: TreeNode;
  depth: number;
}

/** 默认勾选：已跟踪变更勾选，未跟踪/冲突/忽略不勾选 */
export function defaultChecked(f: FileChange): boolean {
  return f.kind !== 'untracked' && f.kind !== 'conflicted' && f.kind !== 'ignored';
}

export function isChecked(f: FileChange, saved: Record<string, boolean>): boolean {
  return saved[f.path] ?? defaultChecked(f);
}

export function buildTree(groupKey: string, files: FileChange[], flat: boolean): TreeNode[] {
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  const mk = (f: FileChange, name: string): TreeNode => ({
    key: `${groupKey}:${f.path}`,
    name,
    path: f.path,
    isDir: false,
    file: f,
    children: [],
    files: [f.path],
    added: f.added ?? 0,
    removed: f.removed ?? 0,
  });
  if (flat) return sorted.map((f) => mk(f, f.path));

  const root: TreeNode = { key: groupKey, name: '', path: '', isDir: true, children: [], files: [], added: 0, removed: 0 };
  for (const f of sorted) {
    const parts = f.path.split('/');
    let cur = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const dirPath = parts.slice(0, i + 1).join('/');
      let next = cur.children.find((c) => c.isDir && c.path === dirPath);
      if (!next) {
        next = { key: `${groupKey}:${dirPath}/`, name: parts[i], path: dirPath, isDir: true, children: [], files: [], added: 0, removed: 0 };
        cur.children.push(next);
      }
      cur = next;
    }
    cur.children.push(mk(f, parts[parts.length - 1]));
  }
  const finalize = (n: TreeNode): void => {
    if (!n.isDir) return;
    n.children.forEach(finalize);
    // 合并只有一个子目录的目录链：src/app/x → "src/app"
    n.children = n.children.map((c) => {
      let node = c;
      while (node.isDir && node.children.length === 1 && node.children[0].isDir) {
        const only = node.children[0];
        node = { ...only, name: `${node.name}/${only.name}` };
      }
      return node;
    });
    // 目录在前，文件在后
    n.children.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
    n.files = n.children.flatMap((c) => c.files);
    n.added = n.children.reduce((s, c) => s + c.added, 0);
    n.removed = n.children.reduce((s, c) => s + c.removed, 0);
  };
  finalize(root);
  return root.children;
}

export function checkState(paths: string[], checked: (p: string) => boolean): CheckState {
  if (paths.length === 0) return 'unchecked';
  let on = 0;
  for (const p of paths) if (checked(p)) on++;
  return on === 0 ? 'unchecked' : on === paths.length ? 'checked' : 'partial';
}

/** 点击三态复选框：全选 → 全不选；部分/未选 → 全选 */
export function toggleAll(paths: string[], current: CheckState): Record<string, boolean> {
  const next = current !== 'checked';
  return Object.fromEntries(paths.map((p) => [p, next]));
}

export function flatten(nodes: TreeNode[], expanded: (key: string) => boolean, depth = 0, out: FlatRow[] = []): FlatRow[] {
  for (const n of nodes) {
    out.push({ node: n, depth });
    if (n.isDir && expanded(n.key)) flatten(n.children, expanded, depth + 1, out);
  }
  return out;
}

export function allDirKeys(nodes: TreeNode[], out: string[] = []): string[] {
  for (const n of nodes) {
    if (n.isDir) {
      out.push(n.key);
      allDirKeys(n.children, out);
    }
  }
  return out;
}

export const KIND_LETTER: Record<FileChange['kind'], string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  typeChanged: 'T',
  untracked: 'U',
  conflicted: '!',
  ignored: 'I',
};
