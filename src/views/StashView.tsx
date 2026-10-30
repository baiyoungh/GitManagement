// Stash 标签页（C-10，specs/04 第 5 节）：列表、文件差异、应用 / 弹出 / 删除 / 从 stash 建分支
import { useEffect, useState } from 'react';
import { SplitView } from '../components/SplitView';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../api';
import type { FileChange, StashEntry, StashFile } from '../api/types';
import { invalidateRepo, reportError, useStashes, useStatus } from '../api/queries';
import { useApp } from '../stores/appStore';
import { useContextMenu, type MenuItem } from '../components/ui';
import { Icon } from '../components/Icon';
import { DiffViewer, type DiffTarget } from './DiffViewer';
import { dateTime, relativeTime } from '../lib/format';
import { errorMessage } from '../lib/errors';
import { EMPTY_TREE, asFileChange } from '../lib/commitFile';

export function StashView({ repoId }: { repoId: string }) {
  const { t } = useTranslation();
  const stashes = useStashes(repoId);
  const status = useStatus(repoId);
  const ask = useApp((s) => s.ask);
  const prompt = useApp((s) => s.prompt);
  const toast = useApp((s) => s.toast);
  const openDialog = useApp((s) => s.openDialog);
  const setTab = useApp((s) => s.setTab);
  const menu = useContextMenu();
  const [selected, setSelected] = useState<string | null>(null);
  const [file, setFile] = useState<StashFile | null>(null);
  const [busy, setBusy] = useState(false);
  const list = stashes.data ?? [];
  const sel = list.find((s) => s.hash === selected) ?? null;

  useEffect(() => {
    if (!sel && list.length) setSelected(list[0].hash);
  }, [list, sel]);
  useEffect(() => setFile(null), [selected]);

  const files = useQuery({
    queryKey: ['repo', repoId, 'stashFiles', selected],
    queryFn: () => api.stash.files(repoId, selected!),
    enabled: !!selected,
    staleTime: Infinity,
  });

  const hasChanges = (status.data?.files.length ?? 0) > 0;

  const run = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try {
      await fn();
      if (done) toast('success', done);
    } catch (e) {
      reportError(e);
    } finally {
      setBusy(false);
      invalidateRepo(repoId);
    }
  };

  const apply = (s: StashEntry, pop: boolean) =>
    run(async () => {
      const r = await api.stash.apply(repoId, s.hash, pop);
      if (r.conflicts) {
        toast('error', t('stash.conflicts'));
        setTab('changes');
      } else toast('success', t(pop ? 'stash.popped' : 'stash.applied', { name: s.selector }));
    });

  const drop = async (s: StashEntry) => {
    const ok = await ask({
      title: t('stash.dropTitle', { name: s.selector }),
      body: s.message,
      note: t('common.irreversible'),
      danger: true,
      confirmLabel: t('common.delete'),
    });
    if (ok) void run(() => api.stash.drop(repoId, s.hash), t('stash.dropped', { name: s.selector }));
  };

  const toBranch = async (s: StashEntry) => {
    const name = await prompt({ title: t('stash.branchTitle'), label: t('branchDialog.name'), placeholder: 'feature/from-stash' });
    if (name) void run(() => api.stash.branch(repoId, s.hash, name), t('branches.created', { name }));
  };

  const actions = (s: StashEntry): MenuItem[] => [
    { label: t('stash.apply'), disabled: busy, onClick: () => apply(s, false) },
    { label: t('stash.pop'), disabled: busy, onClick: () => apply(s, true) },
    { label: t('stash.toBranch'), disabled: busy, onClick: () => toBranch(s) },
    { separator: true },
    { label: t('stash.drop'), danger: true, disabled: busy, onClick: () => drop(s) },
  ];

  const target: DiffTarget | null =
    sel && file
      ? {
          repoId,
          file: asFileChange(file),
          // 未跟踪部分在 stash^3 中，与空树比较
          left: file.untracked ? { kind: 'commit', rev: EMPTY_TREE } : { kind: 'commit', rev: `${sel.hash}^1` },
          right: { kind: 'commit', rev: file.untracked ? `${sel.hash}^3` : sel.hash },
        }
      : null;

  return (
    <>
    <SplitView id="stash" className="stash" initialSizes={[35, 65]} minSizes={[220, 280]}>
      <div className="stash-left">
        <div className="toolbar small">
          <button className="primary" disabled={!hasChanges} onClick={() => openDialog({ type: 'stashCreate', repoId, paths: [] })}>
            + {t('stash.create')}
          </button>
          <span className="spacer" />
          <button className="icon-btn" onClick={() => invalidateRepo(repoId)} title={t('common.refresh')} aria-label={t('common.refresh')}>
            <Icon name="refresh" />
          </button>
        </div>
        {stashes.isError && <p className="error-text pad">{errorMessage(stashes.error)}</p>}
        {stashes.data && list.length === 0 && <p className="muted pad">{t('stash.empty')}</p>}
        <ul className="stash-list" role="listbox" aria-label={t('nav.stash')}>
          {list.map((s) => (
            <li key={s.hash}>
              <button
                role="option"
                aria-selected={s.hash === selected}
                className={`stash-row ${s.hash === selected ? 'selected' : ''}`}
                onClick={() => setSelected(s.hash)}
                onDoubleClick={() => apply(s, false)}
                onContextMenu={(e) => {
                  setSelected(s.hash);
                  menu.open(e, actions(s));
                }}
              >
                <span className="mono muted">{s.selector}</span>
                <span className="stash-msg">{s.message}</span>
                <span className="muted small-text" title={dateTime(s.time)}>
                  {s.branch ? `${s.branch} · ` : ''}
                  {relativeTime(s.time)}
                  {s.hasUntracked ? ` · ${t('stash.withUntracked')}` : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="stash-right">
        {!sel ? (
          <p className="muted pad">{t('stash.select')}</p>
        ) : (
          <>
            <div className="action-row pad-x">
              {actions(sel)
                .filter((a) => !a.separator)
                .map((a, i) => (
                  <button key={i} disabled={a.disabled} className={a.danger ? 'danger' : undefined} onClick={a.onClick}>
                    {a.label}
                  </button>
                ))}
            </div>
            <SplitView id="stash-details" direction="column" initialSizes={[30, 70]} minSizes={[80, 120]}>
            <div className="commit-files">
              <h4>{t('log.changedFiles', { count: files.data?.length ?? 0 })}</h4>
              <ul>
                {files.data?.map((f) => (
                  <li key={`${f.untracked}:${f.path}`}>
                    <button className={`file-btn ${file?.path === f.path && file.untracked === f.untracked ? 'selected' : ''}`} onClick={() => setFile(f)}>
                      <span className={`kind kind-${f.untracked ? 'untracked' : kindClass(f.status)}`}>{f.untracked ? 'U' : f.status}</span>
                      <span className="mono">
                        {f.oldPath ? `${f.oldPath} → ` : ''}
                        {f.path}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
            <div className="log-diff">
              {target ? <DiffViewer target={target} /> : <p className="muted pad">{t('diff.selectFile')}</p>}
            </div>
            </SplitView>
          </>
        )}
      </div>
    </SplitView>
    {menu.element}
    </>
  );
}

export function kindClass(status: string): FileChange['kind'] {
  return status === 'A' ? 'added' : status === 'D' ? 'deleted' : status === 'R' ? 'renamed' : 'modified';
}
