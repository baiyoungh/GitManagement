// 部分提交（C-03）的选择状态：按 仓库 + 文件 保存，仅在当前会话有效
// （工作区内容变化后 hunk 会变，持久化意义不大）。
import { create } from 'zustand';
import type { Hunk } from '../api/types';
import { reconcile, type FileSelection } from '../lib/partialModel';

interface PartialState {
  sel: Record<string, FileSelection | undefined>;
  set: (repoId: string, path: string, s: FileSelection | undefined) => void;
  /** 差异刷新后按内容对齐 hunk */
  sync: (repoId: string, path: string, hunks: Hunk[], keys: string[]) => void;
  clear: (repoId: string, paths?: string[]) => void;
}

const k = (repoId: string, path: string) => `${repoId}\u0000${path}`;

export const usePartial = create<PartialState>((set, get) => ({
  sel: {},
  set: (repoId, path, s) => set((st) => ({ sel: { ...st.sel, [k(repoId, path)]: s } })),
  sync: (repoId, path, hunks, keys) => {
    const cur = get().sel[k(repoId, path)];
    if (!cur) return;
    const next = reconcile(cur, hunks, keys);
    if (next !== cur) set((st) => ({ sel: { ...st.sel, [k(repoId, path)]: next } }));
  },
  clear: (repoId, paths) =>
    set((st) => {
      const sel = { ...st.sel };
      for (const key of Object.keys(sel)) {
        const [r, p] = key.split('\u0000');
        if (r === repoId && (!paths || paths.includes(p))) delete sel[key];
      }
      return { sel };
    }),
}));

export const partialKey = k;
