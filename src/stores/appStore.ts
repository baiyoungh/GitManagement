import { create } from 'zustand';
import type { CloneRetry } from '../lib/credentials';

export type Tab = 'changes' | 'files' | 'log' | 'branches' | 'mapping' | 'stash';

export type DialogState =
  | { type: 'addRepo' }
  | { type: 'clone'; initial?: CloneRetry }
  | { type: 'settings' }
  | { type: 'push'; repoId: string; branch?: string }
  | { type: 'createBranch'; repoId: string; startPoint?: string }
  | { type: 'renameBranch'; repoId: string; name: string }
  | { type: 'upstream'; repoId: string; name: string }
  | { type: 'deleteBranch'; repoId: string; name: string; upstream?: { remote: string; branch: string } | null }
  // M3
  | { type: 'scan'; root?: string; groupId?: string | null }
  | { type: 'stashCreate'; repoId: string; paths: string[] }
  | { type: 'tag'; repoId: string; target: string; label?: string }
  | { type: 'compare'; repoId: string; left: string; right: string | null }
  | { type: 'fileHistory'; repoId: string; path: string; mode: 'history' | 'blame' }
  | { type: 'branchPopup'; repoId: string }
  | { type: 'repoSwitcher' }
  | null;

export interface PromptOptions {
  title: string;
  label?: string;
  initial?: string;
  placeholder?: string;
  confirmLabel?: string;
  /** 返回错误文案表示不合法 */
  validate?: (v: string) => string | null;
}

interface PromptRequest extends PromptOptions {
  resolve: (v: string | null) => void;
}

export interface ConfirmOptions {
  title: string;
  body: string;
  /** 补充说明，例如是否可恢复 */
  note?: string;
  confirmLabel?: string;
  danger?: boolean;
  /** 列出受影响的项目 */
  items?: string[];
  /** 第二个操作按钮（例如"强制切换"） */
  altLabel?: string;
  altDanger?: boolean;
}

export type Choice = 'confirm' | 'alt' | 'cancel';

interface ConfirmRequest extends ConfirmOptions {
  resolve: (choice: Choice) => void;
}

export interface Toast {
  id: number;
  kind: 'info' | 'success' | 'error';
  message: string;
  detail?: string;
}

interface AppState {
  selectedRepoId: string | null;
  tab: Tab;
  dialog: DialogState;
  confirm: ConfirmRequest | null;
  promptReq: PromptRequest | null;
  toasts: Toast[];
  /** 侧栏 Ctrl/⌘ 多选的仓库（R-06 批量操作） */
  multiSelected: string[];
  /** 总览按分组筛选：undefined = 全部，null = 未分组 */
  overviewGroup: string | null | undefined;
  bottomOpen: boolean;
  bottomTab: 'tasks' | 'log' | 'terminal';
  settings: Record<string, string>;
  selectRepo: (id: string | null) => void;
  setTab: (tab: Tab) => void;
  openDialog: (d: DialogState) => void;
  closeDialog: () => void;
  ask: (opts: ConfirmOptions) => Promise<boolean>;
  choose: (opts: ConfirmOptions) => Promise<Choice>;
  resolveConfirm: (choice: Choice) => void;
  prompt: (opts: PromptOptions) => Promise<string | null>;
  resolvePrompt: (v: string | null) => void;
  setMultiSelected: (ids: string[]) => void;
  showOverview: (group: string | null | undefined) => void;
  toast: (kind: Toast['kind'], message: string, detail?: string) => void;
  dismissToast: (id: number) => void;
  setBottom: (open: boolean, tab?: 'tasks' | 'log' | 'terminal') => void;
  setSettings: (s: Record<string, string>) => void;
  patchSetting: (key: string, value: string) => void;
}

let toastId = 1;

export const useApp = create<AppState>((set, get) => ({
  selectedRepoId: null,
  tab: 'changes',
  dialog: null,
  confirm: null,
  promptReq: null,
  toasts: [],
  multiSelected: [],
  overviewGroup: undefined,
  bottomOpen: false,
  bottomTab: 'tasks',
  settings: {},
  selectRepo: (id) => set({ selectedRepoId: id, multiSelected: [] }),
  setTab: (tab) => set({ tab }),
  openDialog: (dialog) => set({ dialog }),
  closeDialog: () => set({ dialog: null }),
  ask: (opts) => get().choose(opts).then((c) => c === 'confirm'),
  choose: (opts) =>
    new Promise<Choice>((resolve) => {
      get().confirm?.resolve('cancel');
      set({ confirm: { ...opts, resolve } });
    }),
  resolveConfirm: (choice) => {
    const c = get().confirm;
    set({ confirm: null });
    c?.resolve(choice);
  },
  prompt: (opts) =>
    new Promise<string | null>((resolve) => {
      get().promptReq?.resolve(null);
      set({ promptReq: { ...opts, resolve } });
    }),
  resolvePrompt: (v) => {
    const p = get().promptReq;
    set({ promptReq: null });
    p?.resolve(v);
  },
  setMultiSelected: (ids) => set({ multiSelected: ids }),
  showOverview: (group) => set({ selectedRepoId: null, overviewGroup: group, multiSelected: [] }),
  toast: (kind, message, detail) => {
    const id = toastId++;
    set((s) => ({ toasts: [...s.toasts.slice(-4), { id, kind, message, detail }] }));
    if (kind !== 'error') setTimeout(() => get().dismissToast(id), 4000);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  setBottom: (open, tab) => set((s) => ({ bottomOpen: open, bottomTab: tab ?? s.bottomTab })),
  setSettings: (settings) => set({ settings }),
  patchSetting: (key, value) => set((s) => ({ settings: { ...s.settings, [key]: value } })),
}));
