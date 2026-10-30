// 变更标签页（specs/04、06 第 3 节）：变更树 + 提交面板 + 差异预览
import { useEffect, useMemo, useRef, useState } from 'react';
import { SplitView } from '../components/SplitView';
import { useQueryClient } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { api } from '../api';
import type { Changelist, FileChange, PartialFile, Rev, StatusResult } from '../api/types';
import { invalidateRepo, keys, reportError, useChangelists, useChecked, useMessages, useRepos, useStatus } from '../api/queries';
import { useApp } from '../stores/appStore';
import { TriCheckbox, useContextMenu, type MenuItem } from '../components/ui';
import { Icon } from '../components/Icon';
import { DiffViewer, type DiffTarget } from './DiffViewer';
import { ConflictsDialog } from '../dialogs/ConflictsDialog';
import { KIND_LETTER, allDirKeys, buildTree, checkState, flatten, isChecked, toggleAll, type TreeNode } from '../lib/changeTree';
import { errorMessage } from '../lib/errors';
import { isMac } from '../lib/format';
import { fileState, hunkKeys, sameHunk, toRequest } from '../lib/partialModel';
import { usePartial, partialKey } from '../stores/partialStore';

const ROW_H = 24;

interface Group {
  key: string;
  label: string;
  files: FileChange[];
  nodes: TreeNode[];
  /** 变更列表分组（C-09） */
  list?: Changelist;
}

/** 文件所属的变更列表：明确归属的列表，否则为活动列表（specs/04 第 4 节） */
export function listOf(path: string, lists: Changelist[]): Changelist | undefined {
  return lists.find((l) => l.files.includes(path)) ?? lists.find((l) => l.active) ?? lists[0];
}

function useGroups(status: StatusResult | undefined, flat: boolean, staging: boolean, lists: Changelist[], t: TFunction): Group[] {
  return useMemo(() => {
    if (!status) return [];
    const files = status.files.filter((f) => f.kind !== 'ignored');
    const conflicts = files.filter((f) => f.kind === 'conflicted');
    const untracked = files.filter((f) => f.kind === 'untracked' && !lists.some((l) => l.files.includes(f.path)));
    const tracked = files.filter((f) => f.kind !== 'conflicted' && !untracked.includes(f));
    const groups: Omit<Group, 'nodes'>[] = [];
    if (conflicts.length) groups.push({ key: 'conflicts', label: t('changes.groupConflicts'), files: conflicts });
    if (staging) {
      groups.push({ key: 'staged', label: t('changes.groupStaged'), files: tracked.filter((f) => f.staged) });
      groups.push({ key: 'unstaged', label: t('changes.groupUnstaged'), files: tracked.filter((f) => !f.staged) });
    } else if (lists.length <= 1) {
      groups.push({ key: 'changes', label: lists[0] && lists[0].name !== 'Changes' ? lists[0].name : t('changes.groupChanges'), files: tracked, list: lists[0] });
    } else {
      for (const l of lists) {
        const fs = tracked.filter((f) => listOf(f.path, lists)?.id === l.id);
        groups.push({ key: `cl:${l.id}`, label: l.name === 'Changes' ? t('changes.groupChanges') : l.name, files: fs, list: l });
      }
    }
    if (untracked.length) groups.push({ key: 'untracked', label: t('changes.groupUnversioned'), files: untracked });
    return groups.map((g) => ({ ...g, nodes: buildTree(g.key, g.files, flat) }));
  }, [status, flat, staging, lists, t]);
}

function diffSides(f: FileChange, hasHead: boolean, staging: boolean, groupKey: string): { left: Rev; right: Rev } {
  if (staging && groupKey === 'staged') return { left: hasHead ? { kind: 'commit', rev: 'HEAD' } : { kind: 'index' }, right: { kind: 'index' } };
  if (staging && groupKey === 'unstaged') return { left: { kind: 'index' }, right: { kind: 'worktree' } };
  return { left: hasHead ? { kind: 'commit', rev: 'HEAD' } : { kind: 'index' }, right: { kind: 'worktree' } };
}

export function ChangesView({ repoId }: { repoId: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const status = useStatus(repoId);
  const saved = useChecked(repoId);
  const repos = useRepos();
  const repo = repos.data?.find((r) => r.id === repoId);
  const settings = useApp((s) => s.settings);
  const patchSetting = useApp((s) => s.patchSetting);
  const ask = useApp((s) => s.ask);
  const toast = useApp((s) => s.toast);
  const openDialog = useApp((s) => s.openDialog);
  const menu = useContextMenu();

  const flat = settings['changes.flat'] === 'true';
  const staging = settings['changes.staging'] === 'true';
  const setPref = (k: string, v: string) => {
    patchSetting(k, v);
    void api.settings.set(k, v);
  };

  const changelists = useChangelists(repoId);
  const lists = useMemo(() => changelists.data ?? [], [changelists.data]);
  const groups = useGroups(status.data, flat, staging, lists, t);
  const prompt = useApp((s) => s.prompt);
  const partialSel = usePartial((s) => s.sel);
  const clearPartial = usePartial((s) => s.clear);
  const selOf = (p: string) => partialSel[partialKey(repoId, p)];
  const allFiles = useMemo(() => status.data?.files.filter((f) => f.kind !== 'ignored') ?? [], [status.data]);
  const byPath = useMemo(() => new Map(allFiles.map((f) => [f.path, f])), [allFiles]);
  const hasHead = !!status.data?.branch.oid;

  // ---------- 勾选状态（按仓库持久化） ----------
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  useEffect(() => setOverrides({}), [repoId]);
  const checkedMap = { ...(saved.data ?? {}), ...overrides };
  const checkedRaw = (p: string) => {
    const f = byPath.get(p);
    if (!f) return false;
    if (staging && f.staged) return true; // 暂存区模式：已暂存的内容必定进入提交
    return isChecked(f, checkedMap);
  };
  // 部分提交：差异中全部 hunk 都取消时视为未勾选
  const checked = (p: string) => checkedRaw(p) && (staging || fileState(selOf(p)) !== 'none');
  const isPartial = (p: string) => !staging && checkedRaw(p) && fileState(selOf(p)) === 'partial';
  /** 文件或目录节点的三态：包含部分提交的文件时显示为"部分" */
  const nodeState = (paths: string[]) => {
    const st = checkState(paths, checked);
    return st === 'checked' && paths.some(isPartial) ? 'partial' : st;
  };
  const persistTimer = useRef<number>();
  const setChecked = (entries: Record<string, boolean>) => {
    const next = { ...overrides, ...entries };
    setOverrides(next);
    window.clearTimeout(persistTimer.current);
    persistTimer.current = window.setTimeout(() => {
      api.checked
        .set(repoId, next, allFiles.map((f) => f.path))
        .then(() => qc.setQueryData(keys.checked(repoId), { ...(saved.data ?? {}), ...next }))
        .catch(reportError);
    }, 300);
  };

  // ---------- 展开/选中 ----------
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const expanded = (k: string) => !collapsed.has(k);

  type VRow = { type: 'group'; group: Group } | { type: 'node'; node: TreeNode; depth: number; group: Group };
  const rows: VRow[] = useMemo(() => {
    const out: VRow[] = [];
    for (const g of groups) {
      out.push({ type: 'group', group: g });
      if (expanded(`group:${g.key}`)) for (const r of flatten(g.nodes, expanded)) out.push({ type: 'node', node: r.node, depth: r.depth + 1, group: g });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups, collapsed]);

  const selectedRow = rows.find((r) => r.type === 'node' && r.node.key === selectedKey) as Extract<VRow, { type: 'node' }> | undefined;
  const selectedFile = selectedRow && !selectedRow.node.isDir ? selectedRow.node.file : undefined;
  const partialEligible = (f: FileChange) =>
    !staging && hasHead && !f.origPath && !f.submodule && (f.kind === 'modified' || f.kind === 'added' || f.kind === 'untracked');
  const diffTarget: DiffTarget | null =
    selectedFile && selectedRow
      ? {
          repoId,
          file: selectedFile,
          ...diffSides(selectedFile, hasHead, staging, selectedRow.group.key),
          selectable: partialEligible(selectedFile),
          switchableLeft: !staging && selectedFile.kind !== 'untracked' && selectedFile.kind !== 'conflicted',
        }
      : null;
  // 在差异中勾选了某个 hunk，而文件本身未勾选 → 自动勾选文件
  const selectedSel = selectedFile ? selOf(selectedFile.path) : undefined;
  useEffect(() => {
    if (selectedFile && selectedSel && fileState(selectedSel) !== 'none' && !checkedRaw(selectedFile.path)) setChecked({ [selectedFile.path]: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSel]);

  const parentRef = useRef<HTMLDivElement>(null);
  const virt = useVirtualizer({ count: rows.length, getScrollElement: () => parentRef.current, estimateSize: () => ROW_H, overscan: 20 });

  // ---------- 提交面板 ----------
  const [message, setMessage] = useState('');
  const [amend, setAmend] = useState(false);
  const [signoff, setSignoff] = useState(false);
  const [noVerify, setNoVerify] = useState(false);
  const [author, setAuthor] = useState('');
  const [busy, setBusy] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const messages = useMessages(repoId);
  const msgRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    setMessage('');
    setAmend(false);
  }, [repoId]);

  // 合并进行中时预填 MERGE_MSG（specs/05 第 2.4 节）
  const operation = status.data?.operation;
  useEffect(() => {
    if (operation === 'merge' && !message) api.commit.mergeMessage(repoId).then((m) => m && setMessage(m), () => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [operation, repoId]);

  const onAmend = async (v: boolean) => {
    setAmend(v);
    if (v && !message.trim()) {
      const m = await api.commit.headMessage(repoId).catch(() => null);
      if (m) setMessage(m);
    }
  };

  const includedPaths = allFiles.filter((f) => f.kind !== 'conflicted' && checked(f.path) && !(staging && f.staged)).map((f) => f.path);
  const partialFiles: PartialFile[] = includedPaths
    .filter((p) => isPartial(p) && byPath.get(p) && partialEligible(byPath.get(p)!))
    .map((p) => ({ path: p, hunks: toRequest(selOf(p)!) }));
  const selectedPaths = includedPaths.filter((p) => !partialFiles.some((x) => x.path === p));
  const stagedCount = staging ? allFiles.filter((f) => f.staged).length : 0;
  const stats = allFiles
    .filter((f) => checked(f.path))
    .reduce((s, f) => ({ a: s.a + (f.added ?? 0), r: s.r + (f.removed ?? 0) }), { a: 0, r: 0 });
  const conflictsCount = allFiles.filter((f) => f.kind === 'conflicted').length;
  const firstLine = message.split('\n')[0] ?? '';
  // 合并 / cherry-pick / revert 进行中且冲突已解决：无需勾选文件即可提交（完成操作）
  const finishingOp = operation === 'merge' || operation === 'cherryPick' || operation === 'revert';
  const canCommit =
    !busy && conflictsCount === 0 && (includedPaths.length + stagedCount > 0 || amend || finishingOp) && (message.trim().length > 0 || amend);

  /** 提交前检查（specs/04 第 2.3 节）；有问题时询问是否继续 */
  const precheckOk = async (paths: string[]) => {
    if (paths.length === 0 || settings['precheck.enabled'] === 'false') return true;
    const issues = await api.precheck.run(repoId, paths).catch(() => []);
    if (issues.length === 0) return true;
    return ask({
      title: t('precheck.title'),
      body: t('precheck.body', { count: issues.length }),
      items: issues.map((i) =>
        i.kind === 'largeFile'
          ? t('precheck.largeFile', { path: i.path, size: (Number(i.detail) / 1024 / 1024).toFixed(1) })
          : i.kind === 'secret'
            ? t('precheck.secret', { path: i.path, line: i.line, rule: t(`precheck.rule.${i.detail}`) })
            : t('precheck.todo', { path: i.path, line: i.line, text: i.detail }),
      ),
      confirmLabel: t('precheck.commitAnyway'),
      danger: issues.some((i) => i.kind === 'secret'),
    });
  };

  const doCommit = async (andPush: boolean) => {
    if (!canCommit) return;
    setBusy(true);
    try {
      if (!(await precheckOk(includedPaths))) return;
      // 部分提交：选择基于打开差异时的 hunk；文件之后又被修改过则 hunk 已变化，必须重新确认
      for (const pf of partialFiles) {
        const sel = selOf(pf.path)!;
        const d = await api.diff.file(repoId, pf.path, null, { kind: 'commit', rev: 'HEAD' }, { kind: 'worktree' }, {
          whitespace: 'none',
          ignoreCrAtEol: false,
          algorithm: (settings['diff.algorithm'] ?? 'myers') as 'myers' | 'patience' | 'histogram',
          force: true,
        });
        // 内容与行号都必须和用户确认时一致（失败即关闭：宁可要求重新确认，也不提交未勾选的内容）
        const ks = hunkKeys(d.old.text, d.new.text, d.hunks);
        const same = !sel.stale && d.hunks.length === sel.hunks.length && d.hunks.every((h, i) => sameHunk(h, sel.hunks[i]) && ks[i] === sel.keys[i]);
        if (!same) {
          toast('error', t('errors.partial.stale', { path: pf.path }));
          const g = groups.find((x) => x.files.some((f) => f.path === pf.path));
          if (g) setSelectedKey(`${g.key}:${pf.path}`);
          return;
        }
      }
      const res = await api.commit.create(repoId, {
        files: selectedPaths,
        partial: partialFiles,
        message,
        amend,
        signoff,
        noVerify,
        author: author.trim() || null,
        stagingMode: staging,
      });
      toast('success', t('commit.success', { hash: res.shortHash }));
      setMessage('');
      setAmend(false);
      // 部分提交的文件保持勾选（剩余改动通常稍后提交），其余清空覆盖
      setOverrides({});
      clearPartial(repoId);
      void qc.invalidateQueries({ queryKey: keys.messages(repoId) });
      invalidateRepo(repoId);
      if (andPush) openDialog({ type: 'push', repoId });
    } catch (e) {
      reportError(e);
    } finally {
      setBusy(false);
    }
  };

  // ---------- 文件操作 ----------
  const pathsOf = (node: TreeNode) => node.files;

  const rollback = async (paths: string[]) => {
    const files = paths.map((p) => byPath.get(p)).filter((f): f is FileChange => !!f && f.kind !== 'conflicted');
    if (files.length === 0) return;
    const untracked = files.filter((f) => f.kind === 'untracked');
    const added = files.filter((f) => f.kind === 'added');
    const opts = { deleteAdded: false, deleteUntracked: untracked.length > 0 };
    let note = untracked.length > 0 ? `${t('rollback.deleteUntracked')}。${t('rollback.trashNote')}` : t('rollback.trashNote');
    if (added.length > 0) {
      const delAdded = await ask({
        title: t('rollback.title'),
        body: t('rollback.deleteAdded'),
        items: added.map((f) => f.path),
        confirmLabel: t('common.delete'),
        danger: true,
      });
      opts.deleteAdded = delAdded;
      if (delAdded) note = t('rollback.trashNote');
    }
    const ok = await ask({
      title: t('rollback.title'),
      body: t('rollback.body', { count: files.length }),
      items: files.map((f) => `${KIND_LETTER[f.kind]}  ${f.origPath ? `${f.origPath} → ` : ''}${f.path}`),
      note,
      confirmLabel: t('rollback.confirm'),
      danger: true,
    });
    if (!ok) return;
    try {
      const r = await api.changes.rollback(repoId, files.map((f) => f.path), opts);
      toast('success', t('rollback.done', { count: r.restored.length + r.trashed.length }));
    } catch (e) {
      reportError(e);
    } finally {
      invalidateRepo(repoId);
    }
  };

  const copy = (text: string) => void navigator.clipboard.writeText(text).then(() => toast('info', t('common.copied')));
  const sep = repo?.path.includes('\\') ? '\\' : '/';

  const nodeMenu = (e: React.MouseEvent, node: TreeNode) => {
    const paths = pathsOf(node);
    const files = paths.map((p) => byPath.get(p)).filter((f): f is FileChange => !!f);
    const untracked = files.filter((f) => f.kind === 'untracked').map((f) => f.path);
    const mod = isMac ? '⌘' : 'Ctrl+';
    const items: MenuItem[] = [
      {
        label: t('changes.ctxCommitSelected'),
        onClick: () => {
          const entries: Record<string, boolean> = {};
          for (const f of allFiles) entries[f.path] = paths.includes(f.path);
          setChecked(entries);
          msgRef.current?.focus();
        },
      },
      { label: t('changes.ctxShowDiff'), disabled: node.isDir, shortcut: `${mod}D`, onClick: () => setSelectedKey(node.key) },
      { label: t('changes.ctxRollback'), shortcut: isMac ? '⌘⌥Z' : 'Ctrl+Alt+Z', onClick: () => rollback(paths) },
      { separator: true },
      {
        label: t('changes.ctxAddToVcs'),
        disabled: untracked.length === 0 && !files.some((f) => f.kind === 'conflicted'),
        onClick: () =>
          api.changes
            .add(repoId, [...untracked, ...files.filter((f) => f.kind === 'conflicted').map((f) => f.path)])
            .then(() => toast('success', t('changes.added')), reportError)
            .finally(() => invalidateRepo(repoId)),
      },
      {
        label: t('changes.ctxIgnoreGitignore'),
        disabled: untracked.length === 0,
        onClick: () =>
          api.changes
            .ignore(repoId, node.isDir && files.every((f) => f.kind === 'untracked') ? [node.path] : untracked, 'gitignore')
            .then(() => toast('success', t('changes.ignored')), reportError)
            .finally(() => invalidateRepo(repoId)),
      },
      {
        label: t('changes.ctxIgnoreExclude'),
        disabled: untracked.length === 0,
        onClick: () =>
          api.changes
            .ignore(repoId, node.isDir && files.every((f) => f.kind === 'untracked') ? [node.path] : untracked, 'exclude')
            .then(() => toast('success', t('changes.ignored')), reportError)
            .finally(() => invalidateRepo(repoId)),
      },
      { separator: true },
      ...(!staging
        ? [
            ...lists
              .filter((l) => files.some((f) => f.kind !== 'conflicted' && listOf(f.path, lists)?.id !== l.id))
              .map((l) => ({
                label: t('changelist.moveTo', { name: l.name === 'Changes' ? t('changes.groupChanges') : l.name }),
                onClick: () => moveToList(l.id, files.filter((f) => f.kind !== 'conflicted').map((f) => f.path)),
              })),
            { label: t('changelist.newAndMove'), onClick: () => newList(files.filter((f) => f.kind !== 'conflicted').map((f) => f.path)) },
          ]
        : []),
      {
        label: t('changes.ctxStash'),
        disabled: !hasHead || files.length === 0 || files.some((f) => f.kind === 'conflicted'),
        onClick: () => openDialog({ type: 'stashCreate', repoId, paths }),
      },
      { separator: true },
      { label: t('changes.ctxHistory'), disabled: node.isDir || !hasHead || files[0]?.kind === 'untracked', onClick: () => openDialog({ type: 'fileHistory', repoId, path: node.path, mode: 'history' }) },
      { label: t('changes.ctxBlame'), disabled: node.isDir || !hasHead || files[0]?.kind === 'untracked' || files[0]?.kind === 'deleted', onClick: () => openDialog({ type: 'fileHistory', repoId, path: node.path, mode: 'blame' }) },
      { separator: true },
      { label: t('changes.ctxReveal'), disabled: files.length === 1 && files[0].kind === 'deleted', onClick: () => api.external.open(repoId, node.path, 'reveal').catch(reportError) },
      { label: t('changes.ctxCopyAbs'), onClick: () => copy(`${repo?.path ?? ''}${sep}${node.path.split('/').join(sep)}`) },
      { label: t('changes.ctxCopyRel'), onClick: () => copy(node.path) },
    ];
    setSelectedKey(node.key);
    menu.open(e, items);
  };

  // ---------- 变更列表（C-09） ----------
  const refreshLists = () => qc.invalidateQueries({ queryKey: keys.changelists(repoId) });
  const moveToList = (id: string, paths: string[]) => {
    if (paths.length) api.changelist.move(repoId, id, paths).then(refreshLists, reportError);
  };
  const newList = async (paths: string[]) => {
    const name = await prompt({ title: t('changelist.newTitle'), label: t('changelist.name'), validate: (v) => (lists.some((l) => l.name === v) ? t('changelist.exists') : null) });
    if (!name) return;
    try {
      const l = await api.changelist.create(repoId, name);
      if (paths.length) await api.changelist.move(repoId, l.id, paths);
    } catch (e) {
      reportError(e);
    } finally {
      void refreshLists();
    }
  };
  const groupMenu = (e: React.MouseEvent, g: Group) => {
    const l = g.list;
    const paths = g.files.map((f) => f.path);
    const items: MenuItem[] = [
      {
        label: t('changelist.commitThis'),
        disabled: paths.length === 0,
        onClick: () => {
          const entries: Record<string, boolean> = {};
          for (const f of allFiles) entries[f.path] = paths.includes(f.path);
          setChecked(entries);
          msgRef.current?.focus();
        },
      },
      { label: t('changes.ctxStash'), disabled: !hasHead || paths.length === 0 || g.key === 'conflicts', onClick: () => openDialog({ type: 'stashCreate', repoId, paths }) },
      { separator: true },
      { label: t('changelist.new'), disabled: staging, onClick: () => newList([]) },
    ];
    if (l && !staging) {
      items.push(
        { label: t('changelist.setActive'), disabled: l.active && lists.length > 1, onClick: () => api.changelist.setActive(repoId, l.id).then(refreshLists, reportError) },
        {
          label: t('changelist.rename'),
          onClick: async () => {
            const name = await prompt({ title: t('changelist.rename'), label: t('changelist.name'), initial: l.name === 'Changes' ? t('changes.groupChanges') : l.name });
            if (name) api.changelist.rename(l.id, name).then(refreshLists, reportError);
          },
        },
        {
          label: t('changelist.delete'),
          danger: true,
          disabled: lists.length <= 1,
          onClick: async () => {
            const ok = await ask({ title: t('changelist.deleteTitle', { name: g.label }), body: t('changelist.deleteBody') });
            if (ok) api.changelist.delete(repoId, l.id).then(refreshLists, reportError);
          },
        },
      );
    }
    menu.open(e, items);
  };
  // 拖拽文件到列表（HTML5 drag & drop）
  const [dragOver, setDragOver] = useState<string | null>(null);
  const onDragStart = (e: React.DragEvent, paths: string[]) => {
    e.dataTransfer.setData('application/x-gm-paths', JSON.stringify(paths));
    e.dataTransfer.effectAllowed = 'move';
  };
  const dropProps = (g: Group) =>
    g.list && !staging && lists.length > 1
      ? {
          onDragOver: (e: React.DragEvent) => {
            if (!e.dataTransfer.types.includes('application/x-gm-paths')) return;
            e.preventDefault();
            setDragOver(g.key);
          },
          onDragLeave: () => setDragOver(null),
          onDrop: (e: React.DragEvent) => {
            e.preventDefault();
            setDragOver(null);
            try {
              const paths = JSON.parse(e.dataTransfer.getData('application/x-gm-paths')) as string[];
              moveToList(g.list!.id, paths.filter((p) => byPath.get(p)?.kind !== 'conflicted'));
            } catch {
              /* 非本应用的拖拽数据 */
            }
          },
        }
      : {};

  // ---------- 快捷键：⌘K 提交、⌘D 差异、⌘⌥Z 回滚、⌘R 刷新 ----------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement | null)?.closest('.terminal-host')) return;
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      if (k === 'k' && !e.shiftKey) {
        e.preventDefault();
        msgRef.current?.focus();
      } else if (k === 'r' && !e.shiftKey) {
        e.preventDefault();
        invalidateRepo(repoId);
      } else if ((k === 'z' || e.code === 'KeyZ') && e.altKey && selectedRow) {
        e.preventDefault();
        void rollback(pathsOf(selectedRow.node));
      } else if (k === 'enter' && document.activeElement === msgRef.current) {
        e.preventDefault();
        void doCommit(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // 键盘导航：↑↓ 移动选中，空格切换勾选，←→ 折叠/展开
  const onTreeKey = (e: React.KeyboardEvent) => {
    const nodeRows = rows.map((r, i) => ({ r, i })).filter((x) => x.r.type === 'node');
    const idx = nodeRows.findIndex((x) => x.r.type === 'node' && x.r.node.key === selectedKey);
    const cur = idx >= 0 ? (nodeRows[idx].r as Extract<VRow, { type: 'node' }>) : undefined;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = nodeRows[Math.max(0, Math.min(nodeRows.length - 1, idx + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (n && n.r.type === 'node') {
        setSelectedKey(n.r.node.key);
        virt.scrollToIndex(n.i);
      }
    } else if (e.key === ' ' && cur) {
      e.preventDefault();
      const ps = pathsOf(cur.node);
      clearPartial(repoId, ps);
      setChecked(toggleAll(ps, checkState(ps, checked)));
    } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && cur?.node.isDir) {
      e.preventDefault();
      const next = new Set(collapsed);
      if (e.key === 'ArrowLeft') next.add(cur.node.key);
      else next.delete(cur.node.key);
      setCollapsed(next);
    }
  };

  if (status.isError) return <p className="error-text pad">{errorMessage(status.error)}</p>;

  return (
    <>
    <SplitView id="changes" className="changes" initialSizes={[42, 58]} minSizes={[280, 260]}>
      <div className="changes-left">
        <OperationBanner repoId={repoId} status={status.data} conflicts={conflictsCount} />
        <SplitView id="commit" direction="column" initialSizes={[62, 38]} minSizes={[100, 200]}>
        <div className="changes-files">
        <div className="toolbar small">
          <button className="icon-btn" title={`${t('changes.refresh')} (${isMac ? '⌘' : 'Ctrl+'}R)`} aria-label={t('changes.refresh')} onClick={() => invalidateRepo(repoId)}>
            <Icon name="refresh" />
          </button>
          <button className="icon-btn" title={t('changes.expandAll')} aria-label={t('changes.expandAll')} onClick={() => setCollapsed(new Set())}>
            <Icon name="expandAll" />
          </button>
          <button
            className="icon-btn"
            title={t('changes.collapseAll')}
            aria-label={t('changes.collapseAll')}
            onClick={() => setCollapsed(new Set(groups.flatMap((g) => allDirKeys(g.nodes))))}
          >
            <Icon name="collapseAll" />
          </button>
          <select value={flat ? 'flat' : 'tree'} onChange={(e) => setPref('changes.flat', String(e.target.value === 'flat'))} aria-label="view">
            <option value="tree">{t('changes.viewTree')}</option>
            <option value="flat">{t('changes.viewFlat')}</option>
          </select>
          <label className="check">
            <input type="checkbox" checked={staging} onChange={(e) => setPref('changes.staging', String(e.target.checked))} />
            {t('changes.showStaging')}
          </label>
        </div>

        <div className="tree" ref={parentRef} role="tree" tabIndex={0} onKeyDown={onTreeKey} aria-label={t('nav.changes')}>
          {status.isLoading && <p className="muted pad">{t('common.loading')}</p>}
          {status.data && allFiles.length === 0 && <p className="muted pad">{t('changes.empty')}</p>}
          <div style={{ height: virt.getTotalSize(), position: 'relative' }}>
            {virt.getVirtualItems().map((vi) => {
              const r = rows[vi.index];
              const style = { position: 'absolute' as const, top: 0, left: 0, right: 0, height: ROW_H, transform: `translateY(${vi.start}px)` };
              if (r.type === 'group') {
                const g = r.group;
                const paths = g.files.map((f) => f.path);
                const gk = `group:${g.key}`;
                const st = nodeState(paths);
                const add = g.files.reduce((s, f) => s + (f.added ?? 0), 0);
                const rem = g.files.reduce((s, f) => s + (f.removed ?? 0), 0);
                return (
                  <div
                    key={vi.key}
                    className={`tree-row group ${g.key === 'conflicts' ? 'conflict' : ''} ${dragOver === g.key ? 'drop-target' : ''}`}
                    style={style}
                    role="treeitem"
                    aria-expanded={expanded(gk)}
                    onContextMenu={(e) => groupMenu(e, g)}
                    {...dropProps(g)}
                  >
                    <button
                      className="twisty"
                      aria-label={expanded(gk) ? t('common.collapse') : t('common.expand')}
                      onClick={() => {
                        const next = new Set(collapsed);
                        if (next.has(gk)) next.delete(gk);
                        else next.add(gk);
                        setCollapsed(next);
                      }}
                    >
                      <Icon name={expanded(gk) ? 'chevronDown' : 'chevronRight'} size={14} />
                    </button>
                    {g.key !== 'conflicts' && g.key !== 'staged' && (
                      <TriCheckbox
                        state={st}
                        label={g.label}
                        onChange={() => {
                          clearPartial(repoId, paths);
                          setChecked(toggleAll(paths, st === 'partial' && paths.every(checkedRaw) ? 'unchecked' : st));
                        }}
                      />
                    )}
                    <span className="tree-name">
                      {g.label} ({g.files.length})
                      {g.list?.active && lists.length > 1 && <span className="tag">{t('changelist.active')}</span>}
                    </span>
                    {(add > 0 || rem > 0) && (
                      <span className="stat">
                        <span className="add">+{add}</span> <span className="rem">−{rem}</span>
                      </span>
                    )}
                  </div>
                );
              }
              const n = r.node;
              const paths = pathsOf(n);
              const st = nodeState(paths);
              const f = n.file;
              const isSel = n.key === selectedKey;
              const disabled = r.group.key === 'conflicts' || r.group.key === 'staged';
              return (
                <div
                  key={vi.key}
                  className={`tree-row ${isSel ? 'selected' : ''}`}
                  style={{ ...style, paddingLeft: 6 + r.depth * 16 }}
                  role="treeitem"
                  aria-selected={isSel}
                  aria-expanded={n.isDir ? expanded(n.key) : undefined}
                  onClick={() => setSelectedKey(n.key)}
                  onContextMenu={(e) => nodeMenu(e, n)}
                  draggable={!staging && lists.length > 1 && r.group.key !== 'conflicts'}
                  onDragStart={(e) => onDragStart(e, paths)}
                  {...dropProps(r.group)}
                >
                  {n.isDir ? (
                    <button
                      className="twisty"
                      aria-label={expanded(n.key) ? t('common.collapse') : t('common.expand')}
                      onClick={(e) => {
                        e.stopPropagation();
                        const next = new Set(collapsed);
                        if (next.has(n.key)) next.delete(n.key);
                        else next.add(n.key);
                        setCollapsed(next);
                      }}
                    >
                      <Icon name={expanded(n.key) ? 'chevronDown' : 'chevronRight'} size={14} />
                    </button>
                  ) : (
                    <span className="twisty" />
                  )}
                  <TriCheckbox
                    state={st}
                    disabled={disabled}
                    label={n.path}
                    onChange={() => {
                      clearPartial(repoId, paths);
                      setChecked(toggleAll(paths, st === 'partial' && paths.every(checkedRaw) ? 'unchecked' : st));
                    }}
                  />
                  {f && (
                    <span className={`kind kind-${f.kind}`} title={t(`changes.kind.${f.kind}`)}>
                      {KIND_LETTER[f.kind]}
                    </span>
                  )}
                  <span className={`tree-name ${f ? `file-${f.kind}` : 'dir'}`} title={n.path}>
                    {n.isDir ? (
                      <span className="inline-icon">
                        <Icon name="folder" size={14} className="folder-icon" />
                        {n.name}
                      </span>
                    ) : (
                      n.name
                    )}
                    {f?.origPath && <span className="muted"> ← {f.origPath}</span>}
                    {f?.conflict && <span className="muted"> ({f.conflict})</span>}
                    {f && isPartial(f.path) && <span className="muted"> ({t('changes.partial')})</span>}
                  </span>
                  {(n.added > 0 || n.removed > 0) && (
                    <span className="stat">
                      <span className="add">+{n.added}</span> <span className="rem">−{n.removed}</span>
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        </div>
        <div className="commit-panel">
          <div className="commit-options">
            <label className="check">
              <input type="checkbox" checked={amend} onChange={(e) => void onAmend(e.target.checked)} disabled={!hasHead} />
              {t('commit.amend')}
            </label>
            <label className="check">
              <input type="checkbox" checked={signoff} onChange={(e) => setSignoff(e.target.checked)} />
              {t('commit.signoff')}
            </label>
            <label className="check">
              <input type="checkbox" checked={noVerify} onChange={(e) => setNoVerify(e.target.checked)} />
              {t('commit.noVerify')}
            </label>
            <input className="author" value={author} onChange={(e) => setAuthor(e.target.value)} placeholder={t('commit.authorPlaceholder')} aria-label={t('commit.author')} />
          </div>
          <textarea
            ref={msgRef}
            className="commit-message"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={`${t('commit.messagePlaceholder')} (${isMac ? '⌘' : 'Ctrl+'}Enter)`}
            aria-label={t('commit.messagePlaceholder')}
            rows={4}
          />
          <div className="commit-meta">
            <div className="dropdown">
              <button className="small" onClick={() => setHistoryOpen((v) => !v)} aria-expanded={historyOpen}>
                {t('commit.history')} <Icon name="chevronDown" size={12} />
              </button>
              {historyOpen && (
                <div className="dropdown-menu up wide" role="menu" onMouseLeave={() => setHistoryOpen(false)}>
                  {(messages.data ?? []).length === 0 && <p className="muted pad">{t('commit.historyEmpty')}</p>}
                  {(messages.data ?? []).map((m, i) => (
                    <button
                      key={i}
                      role="menuitem"
                      title={m}
                      onClick={() => {
                        setMessage(m);
                        setHistoryOpen(false);
                        msgRef.current?.focus();
                      }}
                    >
                      {m.split('\n')[0]}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <span className={`counter ${firstLine.length > 72 ? 'warn-text' : 'muted'}`} title={t('commit.firstLineHint')}>
              {firstLine.length} / 72
            </span>
          </div>
          <div className="commit-actions">
            <span className="muted">
              {staging && stagedCount > 0
                ? t('commit.selectedStaging', { staged: stagedCount, count: includedPaths.length })
                : t('commit.selected', { count: includedPaths.length, added: stats.a, removed: stats.r })}
              {partialFiles.length > 0 && ` · ${t('commit.partialCount', { count: partialFiles.length })}`}
            </span>
            <span className="spacer" />
            <button className="primary" disabled={!canCommit} onClick={() => void doCommit(false)}>
              {t('commit.commit')}
            </button>
            <button disabled={!canCommit || !status.data?.branch.head} onClick={() => void doCommit(true)}>
              {t('commit.commitAndPush')}
            </button>
          </div>
        </div>
        </SplitView>
      </div>
      <div className="changes-right">
        <DiffViewer target={diffTarget} />
      </div>
    </SplitView>
    {menu.element}
    </>
  );
}

/** 合并/变基进行中的横幅（specs/05 第 2.1、2.4 节）；出现新冲突时自动弹出冲突列表 */
function OperationBanner({ repoId, status, conflicts }: { repoId: string; status?: StatusResult; conflicts: number }) {
  const { t } = useTranslation();
  const ask = useApp((s) => s.ask);
  const toast = useApp((s) => s.toast);
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState(false);
  const op = status?.operation;
  // 冲突数从 0 变为 >0（或切换到有冲突的仓库）时自动弹出一次
  const prevConflicts = useRef(0);
  useEffect(() => {
    if (conflicts > 0 && prevConflicts.current === 0) setDialog(true);
    prevConflicts.current = conflicts;
  }, [conflicts]);
  const dialogEl = dialog ? <ConflictsDialog repoId={repoId} onClose={() => setDialog(false)} /> : null;
  if (!op) return conflicts > 0 ? (
    <div className="banner banner-warn" role="alert">
      <strong>{t('banner.stashConflicts', { count: conflicts })}</strong>
      <button onClick={() => setDialog(true)}>{t('banner.resolve')}</button>
      {dialogEl}
    </div>
  ) : null;
  const opLabel = t(`status.operation.${op}`);

  const run = async (action: 'continue' | 'abort' | 'skip') => {
    if (action === 'abort') {
      const ok = await ask({ title: t('banner.abortTitle', { op: opLabel }), body: t('banner.abortBody'), danger: true, confirmLabel: t('banner.abort') });
      if (!ok) return;
    }
    setBusy(true);
    try {
      const r = await api.operation.action(repoId, action);
      if (r.conflicts) toast('error', t('integrate.conflicts'));
    } catch (e) {
      reportError(e);
    } finally {
      setBusy(false);
      invalidateRepo(repoId);
    }
  };

  return (
    <div className={`banner ${conflicts > 0 ? 'banner-warn' : 'banner-ok'}`} role="alert">
      <div>
        <strong>{conflicts > 0 ? t('banner.conflicts', { op: opLabel, count: conflicts }) : t('banner.resolved', { op: opLabel })}</strong>
        {status?.rebaseStep && <span className="muted"> · {t('banner.rebaseStep', { current: status.rebaseStep[0], total: status.rebaseStep[1] })}</span>}
        {conflicts === 0 && op === 'merge' && <div className="muted small-text">{t('banner.mergeCommitHint')}</div>}
      </div>
      <div className="banner-actions">
        {conflicts > 0 && (
          <button className="primary" disabled={busy} onClick={() => setDialog(true)}>
            {t('banner.resolve')}
          </button>
        )}
        {op !== 'merge' && (
          <button disabled={busy || conflicts > 0} onClick={() => void run('continue')}>
            {t('banner.continue')}
          </button>
        )}
        {op !== 'merge' && (
          <button disabled={busy} onClick={() => void run('skip')}>
            {t('banner.skip')}
          </button>
        )}
        <button disabled={busy} className="danger" onClick={() => void run('abort')}>
          {t('banner.abort')}
        </button>
      </div>
      {dialogEl}
    </div>
  );
}

