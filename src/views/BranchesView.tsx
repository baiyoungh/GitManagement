// 分支标签页（specs/06 第 6 节；B-01 ~ B-05、B-07）
import { useMemo, useState } from 'react';
import { SplitView } from '../components/SplitView';
import { useTranslation } from 'react-i18next';
import { api } from '../api';
import type { BranchInfo, TagInfo } from '../api/types';
import { invalidateRepo, reportError, useBranches, useRemotes, useTags } from '../api/queries';
import { ComparePanel } from './ComparePanel';
import { useApp } from '../stores/appStore';
import { AheadBehind, useContextMenu, type MenuItem } from '../components/ui';
import { Icon } from '../components/Icon';
import { checkoutBranch } from '../lib/actions';
import { useBranchActions } from '../hooks/useBranchActions';
import { dateTime, relativeTime } from '../lib/format';
import { errorMessage } from '../lib/errors';

interface BranchGroup {
  prefix: string;
  branches: BranchInfo[];
}

/** 按第一个 `/` 前缀分组（feature/a、feature/b → feature） */
function groupByPrefix(list: BranchInfo[], nameOf: (b: BranchInfo) => string): BranchGroup[] {
  const map = new Map<string, BranchInfo[]>();
  for (const b of list) {
    const n = nameOf(b);
    const i = n.indexOf('/');
    const p = i > 0 ? n.slice(0, i) : '';
    if (!map.has(p)) map.set(p, []);
    map.get(p)!.push(b);
  }
  return [...map.entries()]
    .sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)))
    .map(([prefix, branches]) => ({ prefix, branches }));
}

export function BranchesView({ repoId }: { repoId: string }) {
  const { t } = useTranslation();
  const branches = useBranches(repoId);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<'info' | 'compare'>('info');
  const tags = useTags(repoId);
  const remotes = useRemotes(repoId);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const openDialog = useApp((s) => s.openDialog);
  const ask = useApp((s) => s.ask);
  const toast = useApp((s) => s.toast);
  const menu = useContextMenu();

  const all = branches.data ?? [];
  const q = query.trim().toLowerCase();
  const filtered = all.filter((b) => !q || b.name.toLowerCase().includes(q));
  const local = filtered.filter((b) => b.kind === 'local');
  const remote = filtered.filter((b) => b.kind === 'remote');
  const current = all.find((b) => b.isHead);
  const sel = all.find((b) => b.fullRef === selected);

  const remotesGrouped = useMemo(() => {
    const m = new Map<string, BranchInfo[]>();
    for (const b of remote) {
      const r = b.remote ?? '';
      if (!m.has(r)) m.set(r, []);
      m.get(r)!.push(b);
    }
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [remote]);

  const refresh = () => invalidateRepo(repoId);

  const { actionsFor, checkout } = useBranchActions(repoId, all, (b) => {
    if (!current) {
      openDialog({ type: 'compare', repoId, left: 'HEAD', right: b.fullRef });
      return;
    }
    setSelected(b.fullRef);
    setSelectedTag(null);
    setDetailTab('compare');
  });

  const row = (b: BranchInfo, label: string, depth: number) => (
    <li key={b.fullRef}>
      <button
        className={`branch-row ${selected === b.fullRef ? 'selected' : ''}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => {
          setSelected(b.fullRef);
          setSelectedTag(null);
        }}
        onDoubleClick={() => void checkout(b)}
        onContextMenu={(e) => {
          setSelected(b.fullRef);
          menu.open(e, actionsFor(b));
        }}
        aria-current={b.isHead ? 'true' : undefined}
      >
        <span className="branch-name">
          {b.isHead && <Icon name="star" size={12} filled className="star" style={{ marginRight: 4 }} />}
          {label}
        </span>
        {b.kind === 'local' && <AheadBehind ahead={b.ahead} behind={b.behind} />}
        {b.upstreamGone && (
          <span className="warn-text inline-icon" title={t('branches.gone')}>
            <Icon name="warning" size={14} />
          </span>
        )}
      </button>
    </li>
  );

  const defaultRemote = remotes.data?.find((r) => r.name === 'origin')?.name ?? remotes.data?.[0]?.name;
  const tagActions = (tg: TagInfo): MenuItem[] => [
    { label: t('branches.checkout'), onClick: () => checkoutBranch(repoId, tg.name).then(refresh) },
    { label: t('branches.newBranchFrom'), onClick: () => openDialog({ type: 'createBranch', repoId, startPoint: tg.name }) },
    { label: t('branches.compareWithCurrent'), disabled: !current, onClick: () => openDialog({ type: 'compare', repoId, left: current!.fullRef, right: `refs/tags/${tg.name}` }) },
    { separator: true },
    ...(remotes.data ?? []).map((r) => ({
      label: t('tags.pushTo', { remote: r.name }),
      onClick: () => api.tag.push(repoId, r.name, tg.name).then(() => useApp.getState().setBottom(true, 'tasks'), reportError),
    })),
    { separator: true },
    {
      label: t('tags.delete'),
      danger: true,
      onClick: async () => {
        const ok = await ask({ title: t('tags.deleteTitle', { name: tg.name }), body: t('tags.deleteBody'), danger: true, confirmLabel: t('common.delete') });
        if (ok) api.tag.delete(repoId, tg.name).then(() => toast('success', t('tags.deleted', { name: tg.name })), reportError).finally(refresh);
      },
    },
    ...(remotes.data ?? []).map((r) => ({
      label: t('tags.deleteRemote', { remote: r.name }),
      danger: true,
      onClick: async () => {
        const ok = await ask({ title: t('tags.deleteRemoteTitle', { name: tg.name, remote: r.name }), body: t('tags.deleteRemoteBody'), note: t('common.irreversible'), danger: true, confirmLabel: t('common.delete') });
        if (ok) api.tag.deleteRemote(repoId, r.name, tg.name).then(() => useApp.getState().setBottom(true, 'tasks'), reportError);
      },
    })),
  ];
  const tagSel = (tags.data ?? []).find((x) => x.name === selectedTag);
  const filteredTags = (tags.data ?? []).filter((x) => !q || x.name.toLowerCase().includes(q));

  const toggle = (k: string) => {
    const n = new Set(collapsed);
    if (n.has(k)) n.delete(k);
    else n.add(k);
    setCollapsed(n);
  };

  const groupTree = (key: string, groups: BranchGroup[], nameOf: (b: BranchInfo) => string, depth: number) =>
    groups.map((g) =>
      g.prefix === '' || g.branches.length === 1 ? (
        g.branches.map((b) => row(b, nameOf(b), depth))
      ) : (
        <li key={`${key}:${g.prefix}`}>
          <button className="branch-folder" style={{ paddingLeft: 8 + depth * 14 }} onClick={() => toggle(`${key}:${g.prefix}`)} aria-expanded={!collapsed.has(`${key}:${g.prefix}`)}>
            <Icon name={collapsed.has(`${key}:${g.prefix}`) ? 'chevronRight' : 'chevronDown'} size={14} /> {g.prefix} ({g.branches.length})
          </button>
          {!collapsed.has(`${key}:${g.prefix}`) && <ul>{g.branches.map((b) => row(b, nameOf(b).slice(g.prefix.length + 1), depth + 1))}</ul>}
        </li>
      ),
    );

  return (
    <>
    <SplitView id="branches" className="branches" initialSizes={[34, 66]} minSizes={[220, 280]}>
      <div className="branches-left">
        <div className="toolbar small">
          <input type="search" placeholder={t('branches.search')} aria-label={t('branches.search')} value={query} onChange={(e) => setQuery(e.target.value)} />
          <button onClick={() => openDialog({ type: 'createBranch', repoId })}>+ {t('branches.newBranch')}</button>
        </div>
        {branches.isError && <p className="error-text pad">{errorMessage(branches.error)}</p>}
        <div className="branch-tree">
          <h3>{t('branches.local')}</h3>
          <ul>{groupTree('local', groupByPrefix(local, (b) => b.name), (b) => b.name, 0)}</ul>
          <h3>{t('branches.remote')}</h3>
          <ul>
            {remotesGrouped.map(([r, list]) => (
              <li key={r}>
                <button className="branch-folder" onClick={() => toggle(`remote:${r}`)} aria-expanded={!collapsed.has(`remote:${r}`)}>
                  <Icon name={collapsed.has(`remote:${r}`) ? 'chevronRight' : 'chevronDown'} size={14} /> {r}
                </button>
                {!collapsed.has(`remote:${r}`) && (
                  <ul>{groupTree(`remote:${r}`, groupByPrefix(list, (b) => b.remoteBranch ?? b.name), (b) => b.remoteBranch ?? b.name, 1)}</ul>
                )}
              </li>
            ))}
          </ul>
          <h3 className="tags-head">
            <button className="branch-folder" onClick={() => toggle('tags')} aria-expanded={!collapsed.has('tags')}>
              <Icon name={collapsed.has('tags') ? 'chevronRight' : 'chevronDown'} size={14} /> {t('tags.title')} ({filteredTags.length})
            </button>
            {defaultRemote && (tags.data ?? []).length > 0 && (
              <button className="small" onClick={() => api.tag.push(repoId, defaultRemote, null).then(() => useApp.getState().setBottom(true, 'tasks'), reportError)}>
                {t('tags.pushAll', { remote: defaultRemote })}
              </button>
            )}
          </h3>
          {!collapsed.has('tags') && (
            <ul>
              {filteredTags.map((tg) => (
                <li key={tg.name}>
                  <button
                    className={`branch-row ${selectedTag === tg.name ? 'selected' : ''}`}
                    onClick={() => {
                      setSelectedTag(tg.name);
                      setSelected(null);
                    }}
                    onContextMenu={(e) => {
                      setSelectedTag(tg.name);
                      setSelected(null);
                      menu.open(e, tagActions(tg));
                    }}
                  >
                    <span className="branch-name inline-icon"><Icon name="tag" size={13} /> {tg.name}</span>
                    <span className="muted small-text">{tg.commit.slice(0, 7)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <div className="branches-right">
        {tagSel ? (
          <div className="branch-detail">
            <h2 className="inline-icon"><Icon name="tag" size={16} /> {tagSel.name}</h2>
            <dl>
              <dt>{t('tags.kind')}</dt>
              <dd>{tagSel.annotated ? t('tags.annotated') : t('tags.lightweight')}</dd>
              <dt>{t('tags.commit')}</dt>
              <dd className="mono">{tagSel.commit.slice(0, 12)}</dd>
              {tagSel.subject && (
                <>
                  <dt>{t('tags.message')}</dt>
                  <dd>{tagSel.subject}</dd>
                </>
              )}
              {tagSel.time > 0 && (
                <>
                  <dt>{t('tags.date')}</dt>
                  <dd>{dateTime(tagSel.time)}</dd>
                </>
              )}
            </dl>
            <div className="action-row">
              {tagActions(tagSel)
                .filter((i) => !i.separator)
                .map((i, idx) => (
                  <button key={idx} disabled={i.disabled} className={i.danger ? 'danger' : undefined} onClick={i.onClick}>
                    {i.label}
                  </button>
                ))}
            </div>
          </div>
        ) : !sel ? (
          <p className="muted pad">{t('branches.selectBranch')}</p>
        ) : (
          <div className={`branch-detail ${detailTab === 'compare' ? 'fill' : ''}`}>
            <h2>
              {sel.isHead && <Icon name="star" size={16} filled className="star" style={{ marginRight: 6 }} />}
              {sel.name}
              {sel.isHead && <span className="tag">{t('branches.current')}</span>}
            </h2>
            <div className="seg" role="tablist">
              <button role="tab" aria-selected={detailTab === 'info'} className={detailTab === 'info' ? 'active' : ''} onClick={() => setDetailTab('info')}>
                {t('branches.info')}
              </button>
              <button
                role="tab"
                aria-selected={detailTab === 'compare'}
                className={detailTab === 'compare' ? 'active' : ''}
                disabled={sel.isHead || !current}
                onClick={() => setDetailTab('compare')}
              >
                {t('branches.compareTab', { current: current?.name ?? 'HEAD' })}
              </button>
            </div>
            {detailTab === 'compare' && current && !sel.isHead ? (
              <ComparePanel key={sel.fullRef} repoId={repoId} left={current.fullRef} right={sel.fullRef} />
            ) : (
            <>
            <dl>
              {sel.kind === 'local' && (
                <>
                  <dt>{t('branches.upstream')}</dt>
                  <dd>
                    {sel.upstream ? (
                      <>
                        <span className="mono">{sel.upstream}</span> <AheadBehind ahead={sel.ahead} behind={sel.behind} />
                        {sel.upstreamGone && <span className="warn-text inline-icon"> <Icon name="warning" size={13} /> {t('branches.gone')}</span>}
                      </>
                    ) : (
                      <span className="muted">{t('branches.noUpstream')}</span>
                    )}
                  </dd>
                </>
              )}
              <dt>{t('branches.lastCommit')}</dt>
              <dd>
                <span className="mono">{sel.oid.slice(0, 10)}</span> {sel.subject}
                <div className="muted" title={dateTime(sel.committerTime)}>
                  {relativeTime(sel.committerTime)}
                </div>
              </dd>
            </dl>
            <div className="action-row">
              {actionsFor(sel)
                .filter((i) => !i.separator)
                .map((i, idx) => (
                  <button key={idx} disabled={i.disabled} className={i.danger ? 'danger' : undefined} onClick={i.onClick}>
                    {i.label}
                  </button>
                ))}
            </div>
            </>
            )}
          </div>
        )}
      </div>
    </SplitView>
    {menu.element}
    </>
  );
}
