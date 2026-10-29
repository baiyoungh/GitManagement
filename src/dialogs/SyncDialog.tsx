// 按规则同步：预览 → 确认 → 执行 → 结果汇总（specs/03 第 3 节；M-05）
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { create } from 'zustand';
import { api } from '../api';
import type { PlannedTarget, SyncReport, TargetResult } from '../api/types';
import { invalidateRepo, reportError } from '../api/queries';
import { useApp } from '../stores/appStore';
import { useTasks, waitForTask } from '../stores/taskStore';
import { Modal, Spinner } from '../components/ui';
import { Icon } from '../components/Icon';
import { errorDetail, errorMessage, isAppError } from '../lib/errors';
import { pullStrategy } from '../lib/actions';

interface SyncDialogState {
  repoId: string;
  /** null = 所有有规则的分支 */
  branches: string[] | null;
  /** null = 所有启用目标 */
  targetIds: string[] | null;
  /** 只执行某个方向（右键"立即推送/拉取"） */
  only?: 'push' | 'pull';
}

const useSyncDialog = create<{ state: SyncDialogState | null; set: (s: SyncDialogState | null) => void }>((set) => ({
  state: null,
  set: (state) => set({ state }),
}));

export function openSyncPreview(repoId: string, branches: string[] | null, targetIds: string[] | null, only?: 'push' | 'pull') {
  useSyncDialog.getState().set({ repoId, branches, targetIds, only });
}

interface Row {
  branch: string;
  t: PlannedTarget;
  action: 'push' | 'pull';
}

const OUTCOME_CLASS: Record<string, string> = {
  success: 'ok-text',
  upToDate: 'muted',
  skipped: 'warn-text',
  cancelled: 'muted',
};

export function SyncDialogHost() {
  const s = useSyncDialog((x) => x.state);
  const close = () => useSyncDialog.getState().set(null);
  if (!s) return null;
  return <SyncDialog key={`${s.repoId}:${s.branches?.join(',')}:${s.targetIds?.join(',')}`} {...s} onClose={close} />;
}

function SyncDialog({ repoId, branches, targetIds, only, onClose }: SyncDialogState & { onClose: () => void }) {
  const { t } = useTranslation();
  const ask = useApp((s) => s.ask);
  const setTab = useApp((s) => s.setTab);
  const mapping = useQuery({ queryKey: ['repo', repoId, 'mapping'], queryFn: () => api.sync.mapping(repoId) });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [phase, setPhase] = useState<'preview' | 'running' | 'done'>('preview');
  const [report, setReport] = useState<SyncReport | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const progress = useTasks((x) => (taskId ? x.tasks[taskId] : undefined));

  const rows: Row[] = useMemo(() => {
    const out: Row[] = [];
    for (const m of mapping.data ?? []) {
      if (!m.ruleId) continue;
      if (branches && !branches.includes(m.branch)) continue;
      for (const tg of m.targets) {
        if (!tg.enabled) continue;
        if (targetIds && !targetIds.includes(tg.targetId)) continue;
        if (tg.direction !== 'push' && only !== 'push') out.push({ branch: m.branch, t: tg, action: 'pull' });
        if (tg.direction !== 'pull' && only !== 'pull') out.push({ branch: m.branch, t: tg, action: 'push' });
      }
    }
    return out;
  }, [mapping.data, branches, targetIds, only]);

  const key = (r: Row) => `${r.branch}|${r.t.targetId}|${r.action}`;
  useEffect(() => {
    // 默认勾选：非 force 且 remote 可用的目标；force 目标默认不勾选（specs/06 推送预览）
    setSelected(new Set(rows.filter((r) => !r.t.remoteMissing && !(r.action === 'push' && r.t.force)).map(key)));
  }, [rows]);

  const toggle = (k: string) => {
    const n = new Set(selected);
    if (n.has(k)) n.delete(k);
    else n.add(k);
    setSelected(n);
  };

  const run = async (retry?: TargetResult[]) => {
    const chosen = retry
      ? rows.filter((r) => retry.some((x) => x.branch === r.branch && x.targetId === r.t.targetId && x.action === r.action))
      : rows.filter((r) => selected.has(key(r)));
    if (chosen.length === 0) return;
    const forced = chosen.filter((r) => r.action === 'push' && r.t.force);
    if (forced.length > 0) {
      const ok = await ask({
        title: t('push.forceTitle'),
        body: t('sync.forceBody'),
        items: forced.map((r) => `${r.branch} → ${r.t.remote ?? r.t.url}/${r.t.remoteBranch}`),
        note: t('common.irreversible'),
        danger: true,
        confirmLabel: t('push.push'),
      });
      if (!ok) return;
    }
    setPhase('running');
    setReport(null);
    try {
      // 精确传递 (分支, 目标, 方向)，双向目标只勾选一个方向时不会执行另一个方向
      const id = await api.task.sync(repoId, {
        branches: null,
        targetIds: null,
        items: chosen.map((r) => ({ branch: r.branch, targetId: r.t.targetId, action: r.action })),
        pullStrategy: pullStrategy(),
        confirmedForce: forced.map((r) => r.t.targetId),
      });
      setTaskId(id);
      const done = await waitForTask(id);
      let rep: SyncReport | null = null;
      const raw = done.output ?? (isAppError(done.error) && done.error.code === 'sync.partial' ? done.error.detail : null);
      if (raw) {
        try {
          rep = JSON.parse(raw) as SyncReport;
        } catch {
          rep = null;
        }
      }
      if (rep) setReport(rep);
      else if (done.error) reportError(done.error);
      setPhase('done');
    } catch (e) {
      reportError(e);
      setPhase('preview');
    } finally {
      invalidateRepo(repoId);
    }
  };

  const failed = report?.results.filter((r) => !['success', 'upToDate'].includes(r.outcome)) ?? [];

  return (
    <Modal
      title={t('sync.title')}
      onClose={onClose}
      width={820}
      footer={
        phase === 'preview' ? (
          <>
            <span className="muted">{t('sync.selected', { count: selected.size })}</span>
            <span className="spacer" />
            <button onClick={onClose}>{t('common.cancel')}</button>
            <button className="primary" disabled={selected.size === 0} onClick={() => run()}>
              {t('sync.run')}
            </button>
          </>
        ) : phase === 'running' ? (
          <>
            <Spinner /> <span className="muted">{progress?.message || t('tasks.state.running')}</span>
            <span className="spacer" />
            <button onClick={() => taskId && api.task.cancel(taskId)}>{t('tasks.cancel')}</button>
          </>
        ) : (
          <>
            {report?.conflict && (
              <button
                className="primary"
                onClick={() => {
                  onClose();
                  setTab('changes');
                }}
              >
                {t('sync.resolveConflicts')}
              </button>
            )}
            <span className="spacer" />
            {failed.length > 0 && <button onClick={() => run(failed)}>{t('sync.retryFailed', { count: failed.length })}</button>}
            <button className="primary" onClick={onClose}>
              {t('common.close')}
            </button>
          </>
        )
      }
    >
      {mapping.isLoading && <p className="muted">{t('common.loading')}</p>}
      {phase === 'preview' && mapping.data && rows.length === 0 && <p className="muted">{t('sync.nothing')}</p>}
      {phase === 'preview' && rows.length > 0 && (
        <table className="grid">
          <thead>
            <tr>
              <th />
              <th>{t('mapping.colBranch')}</th>
              <th>{t('sync.action')}</th>
              <th>{t('sync.target')}</th>
              <th>{t('sync.commits')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const k = key(r);
              const n = r.action === 'push' ? r.t.ahead : r.t.behind;
              return (
                <tr key={k} className={r.action === 'push' && r.t.force ? 'force-row' : undefined}>
                  <td>
                    <input type="checkbox" checked={selected.has(k)} disabled={r.t.remoteMissing} onChange={() => toggle(k)} aria-label={k} />
                  </td>
                  <td className="mono">{r.branch}</td>
                  <td className="inline-icon"><Icon name={r.action === 'push' ? 'push' : 'pull'} size={14} /> {r.action === 'push' ? t('top.push') : t('top.pull')}</td>
                  <td className="mono">
                    {r.t.remote ?? r.t.url}/{r.t.remoteBranch}
                    {r.t.primary && <span className="tag">{t('mapping.primary')}</span>}
                    {r.action === 'push' && r.t.force && <span className="tag tag-warn inline-icon"><Icon name="warning" size={11} /> {t('mapping.force')}</span>}
                  </td>
                  <td>
                    {r.t.remoteMissing ? (
                      <span className="error-text">{t('mapping.remoteMissing')}</span>
                    ) : r.action === 'push' && r.t.remoteBranchExists === false ? (
                      <span className="info-text">{t('push.newBranch')}</span>
                    ) : n == null ? (
                      <span className="muted">?</span>
                    ) : r.action === 'pull' ? (
                      <span className="muted">{t('sync.afterFetch')}</span>
                    ) : (
                      <span className={r.t.behind ? 'warn-text' : undefined}>
                        {t('push.commits', { count: n })}
                        {r.t.behind ? ` · ${t('sync.remoteAhead', { count: r.t.behind })}` : ''}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {phase !== 'preview' && report && (
        <table className="grid">
          <thead>
            <tr>
              <th>{t('mapping.colBranch')}</th>
              <th>{t('sync.action')}</th>
              <th>{t('sync.target')}</th>
              <th>{t('sync.result')}</th>
            </tr>
          </thead>
          <tbody>
            {report.results.map((r, i) => (
              <tr key={i}>
                <td className="mono">{r.branch}</td>
                <td className="inline-icon"><Icon name={r.action === 'push' ? 'push' : 'pull'} size={14} /> {r.action === 'push' ? t('top.push') : t('top.pull')}</td>
                <td className="mono">
                  {r.remote ?? r.url}/{r.remoteBranch}
                </td>
                <td>
                  <span className={OUTCOME_CLASS[r.outcome] ?? 'error-text'}>{t(`sync.outcome.${r.outcome}`)}</span>
                  {r.error && (
                    <details>
                      <summary className="muted">{errorMessage(r.error)}</summary>
                      {errorDetail(r.error) && <pre className="mono small-pre">{errorDetail(r.error)}</pre>}
                    </details>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {phase === 'done' && report?.conflict && <p className="warn-text">{t('sync.conflictStop')}</p>}
    </Modal>
  );
}
