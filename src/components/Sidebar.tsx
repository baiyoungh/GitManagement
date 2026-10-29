// 左侧仓库栏（specs/06 第 1 节）：收藏置顶、自定义分组（R-04，可拖拽排序）、多选批量操作（R-06）
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api';
import type { RepoGroup, RepoView } from '../api/types';
import { keys, queryClient, reportError, useGroups, useRepos, useSummary } from '../api/queries';
import { useApp } from '../stores/appStore';
import { AheadBehind, useContextMenu, type MenuItem } from './ui';
import { Icon } from './Icon';
import { startPull } from '../lib/actions';
import { runBatch } from '../lib/batch';
import { openSyncPreview } from '../dialogs/SyncDialog';
import { isMac } from '../lib/format';

const DND_REPO = 'application/x-gm-repo';
const DND_GROUP = 'application/x-gm-group';

function RepoItem(props: {
  repo: RepoView;
  selected: boolean;
  multi: boolean;
  onClick: (e: React.MouseEvent) => void;
  onContext: (e: React.MouseEvent) => void;
  onDragStart: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
}) {
  const { t } = useTranslation();
  const { repo } = props;
  const summary = useSummary(repo.id, !repo.missing);
  const [over, setOver] = useState(false);
  const s = summary.data;
  const dot = repo.missing || summary.isError ? '⚠' : s?.operation ? '⚠' : s && s.changes > 0 ? '●' : '○';
  const dotTitle = repo.missing
    ? t('sidebar.missing')
    : summary.isError
      ? t('status.error')
      : s?.operation
        ? t(`status.operation.${s.operation}`)
        : s && s.changes > 0
          ? t('status.dirty')
          : t('status.clean');
  return (
    <li
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(DND_REPO)) return;
        e.preventDefault();
        e.stopPropagation();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false);
        props.onDrop(e);
      }}
      className={over ? 'drop-before' : undefined}
    >
      <button
        className={`repo-item ${props.selected ? 'selected' : ''} ${props.multi ? 'multi' : ''}`}
        onClick={props.onClick}
        onContextMenu={props.onContext}
        draggable
        onDragStart={props.onDragStart}
        title={repo.path}
        aria-current={props.selected ? 'true' : undefined}
        aria-pressed={props.multi || undefined}
      >
        <span className={`repo-dot ${dot === '⚠' ? 'warn' : dot === '●' ? 'dirty' : ''}`} title={dotTitle} aria-label={dotTitle}>
          {dot === '⚠' ? <Icon name="warning" size={14} /> : <Icon name={dot === '●' ? 'dot' : 'circle'} size={14} />}
        </span>
        <span className="repo-main">
          <span className="repo-name">
            {repo.name}
            <span className="repo-branch">{s?.branch ?? (s?.detached ? s.headShort : '')}</span>
          </span>
          <span className="repo-meta">
            {s?.operation ? <span className="warn-text">{t(`status.operation.${s.operation}`)}</span> : s && s.changes > 0 && <span className="inline-icon"><Icon name="edit" size={12} />{s.changes}</span>}
            {s && <AheadBehind ahead={s.ahead} behind={s.behind} />}
            {repo.missing && <span className="warn-text">{t('sidebar.missing')}</span>}
          </span>
        </span>
      </button>
    </li>
  );
}

interface Section {
  key: string;
  title: string;
  fav?: boolean;
  group?: RepoGroup;
  /** 拖入后的目标分组；undefined 表示不接受拖入（收藏区） */
  targetGroup?: string | null;
  repos: RepoView[];
}

export function Sidebar() {
  const { t } = useTranslation();
  const repos = useRepos();
  const groups = useGroups();
  const [query, setQuery] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const selectedRepoId = useApp((s) => s.selectedRepoId);
  const selectRepo = useApp((s) => s.selectRepo);
  const multi = useApp((s) => s.multiSelected);
  const setMulti = useApp((s) => s.setMultiSelected);
  const showOverview = useApp((s) => s.showOverview);
  const openDialog = useApp((s) => s.openDialog);
  const ask = useApp((s) => s.ask);
  const prompt = useApp((s) => s.prompt);
  const menu = useContextMenu();
  const [dragGroup, setDragGroup] = useState<string | null>(null);

  const all = repos.data ?? [];
  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return all.filter((r) => !q || r.name.toLowerCase().includes(q) || r.path.toLowerCase().includes(q));
  }, [all, query]);
  const groupList = groups.data ?? [];

  const sections: Section[] = useMemo(() => {
    const out: Section[] = [];
    const favorites = list.filter((r) => r.favorite);
    if (favorites.length) out.push({ key: 'fav', title: t('sidebar.favorites'), fav: true, repos: favorites });
    const rest = list.filter((r) => !r.favorite);
    // 数据库排序：favorite DESC, sort, name —— 组内保持该顺序
    for (const g of groupList) out.push({ key: g.id, title: g.name, group: g, targetGroup: g.id, repos: rest.filter((r) => r.groupId === g.id) });
    const known = new Set(groupList.map((g) => g.id));
    const ungrouped = rest.filter((r) => !r.groupId || !known.has(r.groupId));
    if (ungrouped.length || groupList.length === 0)
      out.push({ key: 'none', title: groupList.length ? t('groups.ungrouped') : t('sidebar.others'), targetGroup: null, repos: ungrouped });
    return out;
  }, [list, groupList, t]);

  const refreshRepos = () => queryClient.invalidateQueries({ queryKey: keys.repos });
  const refreshGroups = () => queryClient.invalidateQueries({ queryKey: keys.groups });
  const multiRepos = all.filter((r) => multi.includes(r.id));

  // ---------- 点击：普通选中 / ⌘(Ctrl) 多选 / ⇧ 连续选 ----------
  const flatOrder = sections.flatMap((s) => (s.group?.collapsed ? [] : s.repos));
  const onRepoClick = (repo: RepoView) => (e: React.MouseEvent) => {
    const mod = isMac ? e.metaKey : e.ctrlKey;
    if (mod || e.shiftKey) {
      const base = multi.length ? multi : selectedRepoId ? [selectedRepoId] : [];
      let next: string[];
      const anchor = flatOrder.findIndex((r) => r.id === base[base.length - 1]);
      if (e.shiftKey && base.length && anchor >= 0) {
        const a = anchor;
        const b = flatOrder.findIndex((r) => r.id === repo.id);
        const [lo, hi] = a < b ? [a, b] : [b, a];
        next = [...new Set([...base, ...flatOrder.slice(lo, hi + 1).map((r) => r.id)])];
      } else next = base.includes(repo.id) ? base.filter((x) => x !== repo.id) : [...base, repo.id];
      setMulti(next.length > 1 ? next : []);
      if (next.length === 1) selectRepo(next[0]);
      return;
    }
    selectRepo(repo.id);
  };

  // ---------- 拖拽 ----------
  const onRepoDragStart = (repo: RepoView) => (e: React.DragEvent) => {
    const ids = multi.includes(repo.id) ? multi : [repo.id];
    e.dataTransfer.setData(DND_REPO, JSON.stringify(ids));
    e.dataTransfer.effectAllowed = 'move';
  };
  /** 把拖动的仓库放进分组，插在 beforeId 之前（为空则放到末尾） */
  const dropRepos = async (e: React.DragEvent, sec: Section, beforeId: string | null) => {
    if (!e.dataTransfer.types.includes(DND_REPO) || sec.targetGroup === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    let ids: string[] = [];
    try {
      ids = JSON.parse(e.dataTransfer.getData(DND_REPO)) as string[];
    } catch {
      return;
    }
    const members = all.filter((r) => (sec.targetGroup ? r.groupId === sec.targetGroup : !r.groupId || !groupList.some((g) => g.id === r.groupId)));
    const order = members.map((r) => r.id).filter((id) => !ids.includes(id));
    const at = beforeId ? order.indexOf(beforeId) : -1;
    order.splice(at >= 0 ? at : order.length, 0, ...ids);
    try {
      await api.group.moveRepos(sec.targetGroup, order);
    } catch (err) {
      reportError(err);
    } finally {
      void refreshRepos();
    }
  };
  const dropGroup = async (e: React.DragEvent, beforeId: string) => {
    if (!e.dataTransfer.types.includes(DND_GROUP)) return;
    e.preventDefault();
    const id = e.dataTransfer.getData(DND_GROUP);
    setDragGroup(null);
    if (!id || id === beforeId) return;
    const order = groupList.map((g) => g.id).filter((g) => g !== id);
    order.splice(order.indexOf(beforeId), 0, id);
    await api.group.reorder(order).catch(reportError);
    void refreshGroups();
  };

  // ---------- 菜单 ----------
  const newGroup = async (repoIds: string[] = []) => {
    const name = await prompt({ title: t('groups.new'), label: t('groups.name') });
    if (!name) return;
    try {
      const g = await api.group.create(name);
      if (repoIds.length) await api.group.moveRepos(g.id, [...all.filter((r) => r.groupId === g.id).map((r) => r.id), ...repoIds]);
    } catch (e) {
      reportError(e);
    } finally {
      void refreshGroups();
      void refreshRepos();
    }
  };

  const moveItems = (ids: string[]): MenuItem[] => [
    ...groupList.map((g) => ({
      label: t('groups.moveTo', { name: g.name }),
      onClick: () => Promise.all(ids.map((id) => api.group.setRepoGroup(id, g.id))).then(refreshRepos, reportError),
    })),
    { label: t('groups.moveToNone'), onClick: () => Promise.all(ids.map((id) => api.group.setRepoGroup(id, null))).then(refreshRepos, reportError) },
    { label: t('groups.newAndMove'), onClick: () => newGroup(ids) },
  ];

  const contextFor = (repo: RepoView) => (e: React.MouseEvent) => {
    if (multi.length > 1 && multi.includes(repo.id)) {
      menu.open(e, [
        { label: t('batch.fetch', { count: multiRepos.length }), onClick: () => runBatch('fetch', multiRepos) },
        { label: t('batch.pull', { count: multiRepos.length }), onClick: () => runBatch('pull', multiRepos) },
        { label: t('batch.syncN', { count: multiRepos.length }), onClick: () => runBatch('sync', multiRepos) },
        { separator: true },
        ...moveItems(multi),
        { separator: true },
        { label: t('batch.clearSelection'), onClick: () => setMulti([]) },
      ]);
      return;
    }
    const items: MenuItem[] = [
      { label: t('sidebar.ctxFetch'), disabled: repo.missing, onClick: () => api.task.fetch(repo.id).catch(reportError) },
      { label: t('sidebar.ctxPull'), disabled: repo.missing, onClick: () => startPull(repo.id) },
      { label: t('sidebar.ctxSync'), disabled: repo.missing, onClick: () => openSyncPreview(repo.id, null, null) },
      { separator: true },
      { label: t('sidebar.ctxOpenFiles'), disabled: repo.missing, onClick: () => api.external.open(repo.id, null, 'fileManager').catch(reportError) },
      { label: t('sidebar.ctxOpenTerminal'), disabled: repo.missing, onClick: () => api.external.open(repo.id, null, 'terminal').catch(reportError) },
      {
        label: t('sidebar.ctxOpenEditor'),
        disabled: repo.missing,
        onClick: () =>
          api.external.open(repo.id, null, 'editor').catch((err) => {
            if ((err as { code?: string })?.code === 'open.noEditor') openDialog({ type: 'settings' });
            reportError(err);
          }),
      },
      { label: t('sidebar.ctxCopyPath'), onClick: () => void navigator.clipboard.writeText(repo.path) },
      { separator: true },
      {
        label: repo.favorite ? t('sidebar.ctxUnfavorite') : t('sidebar.ctxFavorite'),
        onClick: () => api.repo.setFavorite(repo.id, !repo.favorite).then(refreshRepos, reportError),
      },
      ...moveItems([repo.id]),
      {
        label: t('sidebar.ctxRename'),
        onClick: async () => {
          const name = await prompt({ title: t('sidebar.ctxRename'), label: t('groups.name'), initial: repo.name });
          if (name) api.repo.rename(repo.id, name).then(refreshRepos, reportError);
        },
      },
      {
        label: repo.watching ? t('sidebar.ctxAutoRefreshOff') : t('sidebar.ctxAutoRefreshOn'),
        disabled: repo.missing,
        onClick: () => api.repo.setWatch(repo.id, !repo.watching).then(refreshRepos, reportError),
      },
      { separator: true },
      {
        label: t('sidebar.ctxRemove'),
        danger: true,
        onClick: async () => {
          const ok = await ask({ title: t('sidebar.removeTitle'), body: t('sidebar.removeBody', { name: repo.name }) });
          if (!ok) return;
          try {
            await api.repo.remove(repo.id);
            if (selectedRepoId === repo.id) selectRepo(null);
            await refreshRepos();
          } catch (err) {
            reportError(err);
          }
        },
      },
    ];
    menu.open(e, items);
  };

  const groupMenu = (g: RepoGroup, members: RepoView[]) => (e: React.MouseEvent) =>
    menu.open(e, [
      { label: t('groups.showOverview'), onClick: () => showOverview(g.id) },
      { label: t('batch.fetch', { count: members.length }), disabled: !members.length, onClick: () => runBatch('fetch', members) },
      { label: t('batch.pull', { count: members.length }), disabled: !members.length, onClick: () => runBatch('pull', members) },
      { label: t('batch.syncN', { count: members.length }), disabled: !members.length, onClick: () => runBatch('sync', members) },
      { separator: true },
      {
        label: t('groups.rename'),
        onClick: async () => {
          const name = await prompt({ title: t('groups.rename'), label: t('groups.name'), initial: g.name });
          if (name) api.group.rename(g.id, name).then(refreshGroups, reportError);
        },
      },
      { label: t('groups.new'), onClick: () => newGroup() },
      {
        label: t('groups.delete'),
        danger: true,
        onClick: async () => {
          const ok = await ask({ title: t('groups.deleteTitle', { name: g.name }), body: t('groups.deleteBody') });
          if (ok)
            api.group
              .delete(g.id)
              .then(() => Promise.all([refreshGroups(), refreshRepos()]), reportError);
        },
      },
    ]);

  const toggleCollapse = (g: RepoGroup) => api.group.setCollapsed(g.id, !g.collapsed).then(refreshGroups, reportError);

  return (
    <aside className="sidebar" aria-label={t('sidebar.repositories')}>
      <div className="sidebar-header">
        <input type="search" placeholder={t('sidebar.search')} aria-label={t('sidebar.search')} value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      <button className={`overview-link ${selectedRepoId === null ? 'selected' : ''}`} onClick={() => showOverview(undefined)}>
        {t('sidebar.overview')} ({all.length})
      </button>
      {multi.length > 1 && (
        <div className="batch-bar" role="toolbar" aria-label={t('batch.selected', { count: multi.length })}>
          <span>{t('batch.selected', { count: multi.length })}</span>
          <button className="small" onClick={() => runBatch('fetch', multiRepos)}>
            Fetch
          </button>
          <button className="small" onClick={() => runBatch('pull', multiRepos)}>
            Pull
          </button>
          <button className="small" onClick={() => runBatch('sync', multiRepos)} title={t('top.sync')} aria-label={t('top.sync')}>
            <Icon name="sync" size={14} />
          </button>
          <button className="icon-btn" onClick={() => setMulti([])} aria-label={t('batch.clearSelection')} title={t('batch.clearSelection')}>
            <Icon name="close" />
          </button>
        </div>
      )}
      <div className="sidebar-list">
        {all.length === 0 && <p className="muted pad">{t('sidebar.empty')}</p>}
        {sections.map((sec) => {
          const g = sec.group;
          const collapsed = !!g?.collapsed && !query;
          return (
            <section
              key={sec.key}
              className={`repo-group ${dragGroup && g && dragGroup !== g.id ? 'group-drop' : ''}`}
              onDragOver={(e) => {
                if (e.dataTransfer.types.includes(DND_REPO) && sec.targetGroup !== undefined) e.preventDefault();
                if (e.dataTransfer.types.includes(DND_GROUP) && g) e.preventDefault();
              }}
              onDrop={(e) => {
                if (g && e.dataTransfer.types.includes(DND_GROUP)) void dropGroup(e, g.id);
                else void dropRepos(e, sec, null);
              }}
            >
              <h3
                draggable={!!g}
                onDragStart={(e) => {
                  if (!g) return;
                  e.dataTransfer.setData(DND_GROUP, g.id);
                  setDragGroup(g.id);
                }}
                onDragEnd={() => setDragGroup(null)}
                onContextMenu={g ? groupMenu(g, sec.repos) : (e) => menu.open(e, [{ label: t('groups.new'), onClick: () => newGroup() }])}
              >
                {g ? (
                  <button className="group-toggle" onClick={() => void toggleCollapse(g)} aria-expanded={!collapsed}>
                    <Icon name={collapsed ? 'chevronRight' : 'chevronDown'} size={14} /> {sec.title} <span className="muted">({sec.repos.length})</span>
                  </button>
                ) : (
                  <span className="inline-icon">
                    {sec.fav && <Icon name="star" size={13} filled className="star" />}
                    {sec.title}
                  </span>
                )}
              </h3>
              {!collapsed && (
                <ul>
                  {sec.repos.map((r) => (
                    <RepoItem
                      key={r.id}
                      repo={r}
                      selected={r.id === selectedRepoId && multi.length === 0}
                      multi={multi.includes(r.id)}
                      onClick={onRepoClick(r)}
                      onContext={contextFor(r)}
                      onDragStart={onRepoDragStart(r)}
                      onDrop={(e) => void dropRepos(e, sec, r.id)}
                    />
                  ))}
                  {sec.repos.length === 0 && g && <li className="muted small-text pad-x">{t('groups.emptyDrop')}</li>}
                </ul>
              )}
            </section>
          );
        })}
      </div>
      <div className="sidebar-footer">
        <div className="dropdown">
          <button onClick={() => setAddOpen((v) => !v)} aria-expanded={addOpen} aria-haspopup="menu">
            <Icon name="plus" size={14} /> {t('sidebar.add')} <Icon name="chevronDown" size={12} />
          </button>
          {addOpen && (
            <div className="dropdown-menu up" role="menu" onMouseLeave={() => setAddOpen(false)}>
              {(
                [
                  ['addRepo', t('sidebar.addLocal')],
                  ['clone', t('sidebar.clone')],
                  ['scan', t('sidebar.scan')],
                ] as const
              ).map(([type, label]) => (
                <button
                  key={type}
                  role="menuitem"
                  onClick={() => {
                    setAddOpen(false);
                    openDialog({ type });
                  }}
                >
                  {label}
                </button>
              ))}
              <button
                role="menuitem"
                onClick={() => {
                  setAddOpen(false);
                  void newGroup();
                }}
              >
                {t('groups.new')}
              </button>
            </div>
          )}
        </div>
      </div>
      {menu.element}
    </aside>
  );
}
