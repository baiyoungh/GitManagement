// 冲突文件列表（specs/05 第 2.1 节；X-01、X-02、X-05）
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../api';
import type { ConflictFile } from '../api/types';
import { invalidateRepo, reportError } from '../api/queries';
import { useApp } from '../stores/appStore';
import { Modal } from '../components/ui';
import { MergeWindow } from './MergeWindow';
import { errorMessage } from '../lib/errors';

function sideStatus(t: (k: string) => string, f: ConflictFile, side: 'ours' | 'theirs') {
  const present = side === 'ours' ? f.hasOurs : f.hasTheirs;
  if (!present) return t('conflicts.deleted');
  if (!f.hasBase) return t('conflicts.added');
  return t('conflicts.modified');
}

export function ConflictsDialog({ repoId, onClose }: { repoId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const ask = useApp((s) => s.ask);
  const ctx = useQuery({ queryKey: ['repo', repoId, 'conflicts'], queryFn: () => api.conflict.context(repoId) });
  const [selected, setSelected] = useState<string | null>(null);
  const [merging, setMerging] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const files = ctx.data?.files ?? [];
  const sel = files.find((f) => f.path === selected) ?? files[0];
  const op = ctx.data?.operation;
  const opLabel = op ? t(`status.operation.${op}`) : t('conflicts.stash');

  const accept = async (side: 'ours' | 'theirs') => {
    if (!sel) return;
    // 一侧为删除时，接受该侧会删除文件
    const deleting = side === 'ours' ? !sel.hasOurs : !sel.hasTheirs;
    if (deleting) {
      const ok = await ask({ title: t('conflicts.deleteTitle'), body: t('conflicts.deleteBody', { path: sel.path }), danger: true, confirmLabel: t('common.delete') });
      if (!ok) return;
    }
    setBusy(true);
    try {
      await api.conflict.accept(repoId, [sel.path], side);
    } catch (e) {
      reportError(e);
    } finally {
      setBusy(false);
      invalidateRepo(repoId);
    }
  };

  const abort = async () => {
    if (!op) return;
    const ok = await ask({ title: t('banner.abortTitle', { op: opLabel }), body: t('banner.abortBody'), danger: true, confirmLabel: t('banner.abort') });
    if (!ok) return;
    try {
      await api.operation.action(repoId, 'abort');
      onClose();
    } catch (e) {
      reportError(e);
    } finally {
      invalidateRepo(repoId);
    }
  };

  if (merging) {
    return (
      <MergeWindow
        repoId={repoId}
        path={merging}
        oursLabel={ctx.data?.oursLabel ?? 'Ours'}
        theirsLabel={ctx.data?.theirsLabel ?? 'Theirs'}
        onClose={() => {
          setMerging(null);
          invalidateRepo(repoId);
        }}
      />
    );
  }

  return (
    <Modal
      title={t('conflicts.title', { op: opLabel, theirs: ctx.data?.theirsLabel ?? '', ours: ctx.data?.oursLabel ?? '' })}
      onClose={onClose}
      width={760}
      footer={
        <>
          <button disabled={!sel || busy} onClick={() => accept('ours')}>
            {t('conflicts.acceptOurs')}
          </button>
          <button disabled={!sel || busy} onClick={() => accept('theirs')}>
            {t('conflicts.acceptTheirs')}
          </button>
          <button className="primary" disabled={!sel || sel.binary || !sel.hasOurs || !sel.hasTheirs || busy} onClick={() => sel && setMerging(sel.path)} title={sel?.binary ? t('conflicts.binaryHint') : undefined}>
            {t('conflicts.merge')}
          </button>
          <span className="spacer" />
          {op && (
            <button className="danger" onClick={abort}>
              {t('banner.abort')}
            </button>
          )}
          <button onClick={onClose}>{t('conflicts.later')}</button>
        </>
      }
    >
      {ctx.isError && <p className="error-text">{errorMessage(ctx.error)}</p>}
      {ctx.data && files.length === 0 && <p className="ok-text">{t('conflicts.allResolved')}</p>}
      {files.length > 0 && (
        <table className="grid selectable">
          <thead>
            <tr>
              <th>{t('conflicts.file')}</th>
              <th>
                {t('conflicts.ours')} ({ctx.data?.oursLabel})
              </th>
              <th>
                {t('conflicts.theirs')} ({ctx.data?.theirsLabel})
              </th>
            </tr>
          </thead>
          <tbody>
            {files.map((f) => (
              <tr
                key={f.path}
                className={sel?.path === f.path ? 'selected' : ''}
                onClick={() => setSelected(f.path)}
                onDoubleClick={() => !f.binary && f.hasOurs && f.hasTheirs && setMerging(f.path)}
                tabIndex={0}
                aria-selected={sel?.path === f.path}
              >
                <td className="mono">
                  <span className="kind kind-conflicted">!</span> {f.path} <span className="muted">({f.code})</span>
                </td>
                <td>{sideStatus(t, f, 'ours')}</td>
                <td>
                  {sideStatus(t, f, 'theirs')}
                  {f.binary && <span className="muted"> ({t('diff.binary')})</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {sel && (!sel.hasOurs || !sel.hasTheirs) && <p className="muted">{t('conflicts.deleteHint')}</p>}
    </Modal>
  );
}
