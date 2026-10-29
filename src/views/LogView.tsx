// 日志标签页（specs/06 第 5 节；L-01 提交图、L-03 提交详情、L-04 提交操作）
import { useEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useTranslation } from 'react-i18next';
import { api } from '../api';
import type { CommitFile, LogCommit, ResetMode } from '../api/types';
import { invalidateRepo, reportError, useBranches, useStatus } from '../api/queries';
import { useApp } from '../stores/appStore';
import { useContextMenu, type MenuItem } from '../components/ui';
import { Icon } from '../components/Icon';
import { DiffViewer } from './DiffViewer';
import { GRAPH_COLORS, layoutGraph, type GraphRow } from '../lib/graph';
import { dateTime, relativeTime } from '../lib/format';
import { errorMessage } from '../lib/errors';

const ROW_H = 24;
const LANE_W = 14;
const PAGE = 500;

function GraphCell({ row, prevWidth }: { row: GraphRow; prevWidth: number }) {
  const w = Math.max(row.width, prevWidth, 1) * LANE_W + 6;
  const x = (lane: number) => lane * LANE_W + LANE_W / 2;
  const mid = ROW_H / 2;
  const color = (c: number) => GRAPH_COLORS[c % GRAPH_COLORS.length];
  return (
    <svg width={w} height={ROW_H} className="graph" aria-hidden="true">
      {/* 上半段：进入本节点的连线 */}
      {row.incoming.map((from) => (
        <line key={`in${from}`} x1={x(from)} y1={0} x2={x(row.lane)} y2={mid} stroke={color(row.color)} strokeWidth={1.6} />
      ))}
      {/* 下半段：离开本行的连线（含直通线） */}
      {row.edges.map((e, i) =>
        e.from === row.lane ? (
          <path key={i} d={`M${x(e.from)} ${mid} C ${x(e.from)} ${ROW_H}, ${x(e.to)} ${mid}, ${x(e.to)} ${ROW_H}`} stroke={color(e.color)} strokeWidth={1.6} fill="none" />
        ) : (
          <path key={i} d={`M${x(e.from)} 0 L ${x(e.from)} ${mid} C ${x(e.from)} ${ROW_H}, ${x(e.to)} ${mid}, ${x(e.to)} ${ROW_H}`} stroke={color(e.color)} strokeWidth={1.6} fill="none" />
        ),
      )}
      <circle cx={x(row.lane)} cy={mid} r={4} fill={color(row.color)} stroke="var(--bg)" strokeWidth={1.5} />
    </svg>
  );
}

function RefBadges({ refs }: { refs: string[] }) {
  return (
    <>
      {refs.map((r) => {
        const tag = r.startsWith('tag: ');
        const head = r.startsWith('HEAD -> ');
        const name = tag ? r.slice(5) : head ? r.slice(8) : r;
        const remote = !tag && !head && r.includes('/');
        return (
          <span key={r} className={`ref ${tag ? 'ref-tag' : remote ? 'ref-remote' : 'ref-local'} ${head ? 'ref-head' : ''}`} title={r}>
            {head && <Icon name="star" size={10} filled className="star" style={{ marginRight: 3 }} />}
            {name}
          </span>
        );
      })}
    </>
  );
}

export function LogView({ repoId }: { repoId: string }) {
  const { t } = useTranslation();
  const ask = useApp((s) => s.ask);
  const toast = useApp((s) => s.toast);
  const openDialog = useApp((s) => s.openDialog);
  const setTab = useApp((s) => s.setTab);
  const status = useStatus(repoId);
  const menu = useContextMenu();
  const [grep, setGrep] = useState('');
  const [grepInput, setGrepInput] = useState('');
  const [branchFilter, setBranchFilter] = useState<string>('all');
  const [author, setAuthor] = useState('');
  const [since, setSince] = useState('');
  const [until, setUntil] = useState('');
  const [pathFilter, setPathFilter] = useState('');
  const [filterInputs, setFilterInputs] = useState({ author: '', path: '' });
  const branches = useBranches(repoId);
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<CommitFile | null>(null);

  useEffect(() => {
    const h = setTimeout(() => {
      setGrep(grepInput.trim());
      setAuthor(filterInputs.author.trim());
      setPathFilter(filterInputs.path.trim());
    }, 300);
    return () => clearTimeout(h);
  }, [grepInput, filterInputs]);

  const refs = branchFilter === 'all' ? [] : branchFilter === 'current' ? ['HEAD'] : [branchFilter];
  const filtered = !!(grep || author || since || until || pathFilter);
  const log = useInfiniteQuery({
    queryKey: ['repo', repoId, 'log', grep, branchFilter, author, since, until, pathFilter],
    queryFn: ({ pageParam }) =>
      api.history.page(repoId, {
        refs,
        skip: pageParam,
        limit: PAGE,
        grep: grep || null,
        author: author || null,
        since: since || null,
        until: until || null,
        paths: pathFilter ? [pathFilter] : [],
      }),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => (last.hasMore ? pages.reduce((n, p) => n + p.commits.length, 0) : undefined),
  });
  const commits: LogCommit[] = useMemo(() => log.data?.pages.flatMap((p) => p.commits) ?? [], [log.data]);
  // 过滤时提交不连续，不画图
  const graph = useMemo(() => (filtered ? [] : layoutGraph(commits)), [commits, filtered]);
  const sel = commits.find((c) => c.hash === selected) ?? null;

  const detail = useQuery({
    queryKey: ['repo', repoId, 'commit', selected],
    queryFn: () => api.history.detail(repoId, selected!),
    enabled: !!selected,
    staleTime: Infinity,
  });

  useEffect(() => setSelectedFile(null), [selected]);

  const parentRef = useRef<HTMLDivElement>(null);
  const virt = useVirtualizer({ count: commits.length, getScrollElement: () => parentRef.current, estimateSize: () => ROW_H, overscan: 30 });
  const items = virt.getVirtualItems();
  useEffect(() => {
    const last = items[items.length - 1];
    if (last && last.index >= commits.length - 20 && log.hasNextPage && !log.isFetchingNextPage) void log.fetchNextPage();
  }, [items, commits.length, log]);

  const refresh = () => invalidateRepo(repoId);
  const busyOp = !!status.data?.operation;

  const afterIntegrate = (r: { conflicts: boolean }) => {
    if (r.conflicts) {
      toast('error', t('integrate.conflicts'));
      setTab('changes');
    } else toast('success', t('integrate.done'));
  };

  const doReset = async (c: LogCommit, mode: ResetMode) => {
    const branch = status.data?.branch.head ?? 'HEAD';
    const ok = await ask({
      title: t('log.resetTitle', { mode }),
      body: t(`log.resetBody_${mode}`, { branch, hash: c.shortHash }),
      note: mode === 'hard' ? t('common.irreversible') : undefined,
      danger: mode === 'hard',
      confirmLabel: 'Reset',
    });
    if (!ok) return;
    api.history.reset(repoId, c.hash, mode).then(() => toast('success', t('log.resetDone', { hash: c.shortHash })), reportError).finally(refresh);
  };

  const createTag = (c: LogCommit) => openDialog({ type: 'tag', repoId, target: c.hash, label: c.shortHash });

  const commitMenu = (e: React.MouseEvent, c: LogCommit) => {
    setSelected(c.hash);
    const items: MenuItem[] = [
      { label: t('log.copyHash'), onClick: () => void navigator.clipboard.writeText(c.hash).then(() => toast('info', t('common.copied'))) },
      { separator: true },
      {
        label: 'Cherry-pick',
        disabled: busyOp,
        onClick: async () => {
          const ok = await ask({ title: 'Cherry-pick', body: t('log.cherryPickBody', { hash: c.shortHash, subject: c.subject }) });
          if (ok) api.history.cherryPick(repoId, c.hash).then(afterIntegrate, reportError).finally(refresh);
        },
      },
      {
        label: 'Revert',
        disabled: busyOp,
        onClick: async () => {
          const ok = await ask({ title: 'Revert', body: t('log.revertBody', { hash: c.shortHash, subject: c.subject }) });
          if (ok) api.history.revert(repoId, c.hash).then(afterIntegrate, reportError).finally(refresh);
        },
      },
      { separator: true },
      { label: t('log.resetSoft'), disabled: busyOp, onClick: () => doReset(c, 'soft') },
      { label: t('log.resetMixed'), disabled: busyOp, onClick: () => doReset(c, 'mixed') },
      { label: t('log.resetHard'), danger: true, disabled: busyOp, onClick: () => doReset(c, 'hard') },
      { separator: true },
      { label: t('branches.newBranchFrom'), onClick: () => openDialog({ type: 'createBranch', repoId, startPoint: c.hash }) },
      { label: t('log.newTag'), onClick: () => createTag(c) },
      { separator: true },
      { label: t('log.compareWorktree'), onClick: () => openDialog({ type: 'compare', repoId, left: c.hash, right: null }) },
      {
        label: t('log.compareHead'),
        disabled: !status.data?.branch.oid || status.data.branch.oid === c.hash,
        onClick: () => openDialog({ type: 'compare', repoId, left: c.hash, right: 'HEAD' }),
      },
    ];
    menu.open(e, items);
  };

  const fileTarget = sel && selectedFile && detail.data
    ? {
        repoId,
        file: {
          path: selectedFile.path,
          origPath: selectedFile.oldPath,
          kind: 'modified' as const,
          indexStatus: '.',
          worktreeStatus: '.',
          staged: false,
          unstaged: false,
          conflict: null,
          submodule: false,
          added: null,
          removed: null,
        },
        left: detail.data.parents[0] ? { kind: 'commit' as const, rev: detail.data.parents[0] } : { kind: 'commit' as const, rev: '4b825dc642cb6eb9a060e54bf8d69288fbee4904' },
        right: { kind: 'commit' as const, rev: sel.hash },
      }
    : null;

  return (
    <div className="log">
      <div className="toolbar small">
        <input type="search" placeholder={t('log.search')} aria-label={t('log.search')} value={grepInput} onChange={(e) => setGrepInput(e.target.value)} />
        <select value={branchFilter} onChange={(e) => setBranchFilter(e.target.value)} aria-label={t('log.branchFilter')}>
          <option value="all">{t('log.allBranches')}</option>
          <option value="current">{t('log.currentBranch')}</option>
          {(branches.data ?? []).map((b) => (
            <option key={b.fullRef} value={b.fullRef}>
              {b.name}
            </option>
          ))}
        </select>
        <input
          className="filter-author"
          placeholder={t('log.author')}
          aria-label={t('log.author')}
          value={filterInputs.author}
          onChange={(e) => setFilterInputs({ ...filterInputs, author: e.target.value })}
        />
        <input type="date" value={since} max={until || undefined} onChange={(e) => setSince(e.target.value)} aria-label={t('log.since')} title={t('log.since')} />
        <span className="muted">–</span>
        <input type="date" value={until} min={since || undefined} onChange={(e) => setUntil(e.target.value)} aria-label={t('log.until')} title={t('log.until')} />
        <input
          className="filter-path"
          placeholder={t('log.path')}
          aria-label={t('log.path')}
          value={filterInputs.path}
          onChange={(e) => setFilterInputs({ ...filterInputs, path: e.target.value })}
        />
        {filtered && (
          <button
            className="small"
            onClick={() => {
              setGrepInput('');
              setFilterInputs({ author: '', path: '' });
              setSince('');
              setUntil('');
            }}
          >
            {t('log.clearFilters')}
          </button>
        )}
        <span className="spacer" />
        <button className="icon-btn" onClick={refresh} title={t('common.refresh')} aria-label={t('common.refresh')}>
          <Icon name="refresh" />
        </button>
      </div>
      <div className="log-body">
        <div className="log-list" ref={parentRef} role="listbox" aria-label={t('nav.log')} tabIndex={0}
          onKeyDown={(e) => {
            if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
            e.preventDefault();
            const i = commits.findIndex((c) => c.hash === selected);
            const n = Math.max(0, Math.min(commits.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
            if (commits[n]) {
              setSelected(commits[n].hash);
              virt.scrollToIndex(n);
            }
          }}
        >
          {log.isLoading && <p className="muted pad">{t('common.loading')}</p>}
          {log.isError && <p className="error-text pad">{errorMessage(log.error)}</p>}
          {log.data && commits.length === 0 && <p className="muted pad">{t('log.empty')}</p>}
          <div style={{ height: virt.getTotalSize(), position: 'relative' }}>
            {items.map((vi) => {
              const c = commits[vi.index];
              const g = graph[vi.index];
              return (
                <div
                  key={c.hash}
                  role="option"
                  aria-selected={c.hash === selected}
                  className={`log-row ${c.hash === selected ? 'selected' : ''}`}
                  style={{ position: 'absolute', top: 0, left: 0, right: 0, height: ROW_H, transform: `translateY(${vi.start}px)` }}
                  onClick={() => setSelected(c.hash)}
                  onContextMenu={(e) => commitMenu(e, c)}
                >
                  {g && <GraphCell row={g} prevWidth={graph[vi.index - 1]?.width ?? 0} />}
                  <span className="log-subject">
                    <RefBadges refs={c.refs} />
                    {c.subject}
                  </span>
                  <span className="log-author muted">{c.authorName}</span>
                  <span className="log-date muted" title={dateTime(c.authorTime)}>
                    {relativeTime(c.authorTime)}
                  </span>
                  <span className="log-hash mono muted">{c.shortHash}</span>
                </div>
              );
            })}
          </div>
          {log.isFetchingNextPage && <p className="muted pad">{t('common.loading')}</p>}
        </div>
        <div className="log-detail">
          {!sel ? (
            <p className="muted pad">{t('log.selectCommit')}</p>
          ) : (
            <>
              <div className="commit-files">
                <h4>{t('log.changedFiles', { count: detail.data?.files.length ?? 0 })}</h4>
                <ul>
                  {detail.data?.files.map((f) => (
                    <li key={f.path}>
                      <button
                        className={`file-btn ${selectedFile?.path === f.path ? 'selected' : ''}`}
                        onClick={() => setSelectedFile(f)}
                        onContextMenu={(e) =>
                          menu.open(e, [
                            { label: t('changes.ctxHistory'), onClick: () => openDialog({ type: 'fileHistory', repoId, path: f.path, mode: 'history' }) },
                            { label: t('changes.ctxBlame'), disabled: f.status === 'D', onClick: () => openDialog({ type: 'fileHistory', repoId, path: f.path, mode: 'blame' }) },
                            { label: t('log.compareFileWorktree'), onClick: () => openDialog({ type: 'compare', repoId, left: sel!.hash, right: null }) },
                          ])
                        }
                      >
                        <span className={`kind kind-${f.status === 'A' ? 'added' : f.status === 'D' ? 'deleted' : f.status === 'R' ? 'renamed' : 'modified'}`}>{f.status}</span>
                        <span className="mono">
                          {f.oldPath ? `${f.oldPath} → ` : ''}
                          {f.path}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
              {detail.data && (
                <div className="commit-meta-box">
                  <div>
                    <span className="mono">{detail.data.hash.slice(0, 10)}</span> · {detail.data.authorName} &lt;{detail.data.authorEmail}&gt;
                  </div>
                  <div className="muted">{dateTime(detail.data.authorTime)}</div>
                  {detail.data.committerName !== detail.data.authorName && (
                    <div className="muted">
                      {t('log.committer')}: {detail.data.committerName} · {dateTime(detail.data.committerTime)}
                    </div>
                  )}
                  {detail.data.parents.length > 0 && (
                    <div className="muted">
                      {t('log.parents')}:{' '}
                      {detail.data.parents.map((p) => (
                        <button key={p} className="link mono" onClick={() => setSelected(p)}>
                          {p.slice(0, 7)}
                        </button>
                      ))}
                    </div>
                  )}
                  <pre className="commit-message-view">{detail.data.message}</pre>
                </div>
              )}
              {fileTarget && (
                <div className="log-diff">
                  <DiffViewer target={fileTarget} />
                </div>
              )}
            </>
          )}
        </div>
      </div>
      {menu.element}
    </div>
  );
}
