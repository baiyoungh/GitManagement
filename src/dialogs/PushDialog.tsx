// 推送预览（specs/06 第 8 节；S-03、C-06）
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../api';
import { reportError } from '../api/queries';
import { useApp } from '../stores/appStore';
import { Field, Modal } from '../components/ui';
import { relativeTime } from '../lib/format';
import { errorMessage } from '../lib/errors';
import { startPull } from '../lib/actions';

export function PushDialog({ repoId, branch }: { repoId: string; branch?: string }) {
  const { t } = useTranslation();
  const close = useApp((s) => s.closeDialog);
  const ask = useApp((s) => s.ask);
  const toast = useApp((s) => s.toast);
  const [remote, setRemote] = useState<string | null>(null);
  const [remoteBranch, setRemoteBranch] = useState<string | null>(null);
  const [rbInput, setRbInput] = useState('');
  const [force, setForce] = useState(false);
  const [tags, setTags] = useState(false);
  const [setUp, setSetUp] = useState(false);

  const preview = useQuery({
    queryKey: ['repo', repoId, 'pushPreview', branch, remote, remoteBranch],
    queryFn: () => api.remote.pushPreview(repoId, branch, remote, remoteBranch),
  });
  const p = preview.data;

  useEffect(() => {
    if (p) {
      setRbInput(p.remoteBranch);
      if (p.newBranch) setSetUp(true);
    }
  }, [p?.remote, p?.remoteBranch, p?.newBranch]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async () => {
    if (!p) return;
    const target = `${p.remote}/${p.remoteBranch}`;
    if (force) {
      const ok = await ask({
        title: t('push.forceTitle'),
        body: t('push.forceBody', { branch: p.branch, target }),
        note: t('common.irreversible'),
        danger: true,
        confirmLabel: t('push.push'),
      });
      if (!ok) return;
    }
    try {
      await api.task.push(repoId, { branch: p.branch, remote: p.remote, remoteBranch: p.remoteBranch, force, tags, setUpstream: setUp });
      useApp.getState().setBottom(true, 'tasks');
      toast('info', t('push.started', { target }));
      close();
    } catch (e) {
      reportError(e);
    }
  };

  return (
    <Modal
      title={t('push.title')}
      onClose={close}
      width={760}
      footer={
        <>
          <label className="check">
            <input type="checkbox" checked={tags} onChange={(e) => setTags(e.target.checked)} />
            {t('push.tags')}
          </label>
          <label className="check">
            <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
            <span className={force ? 'warn-text' : undefined}>{t('push.force')}</span>
          </label>
          <label className="check">
            <input type="checkbox" checked={setUp} onChange={(e) => setSetUp(e.target.checked)} />
            {t('push.setUpstream')}
          </label>
          <span className="spacer" />
          <button onClick={close}>{t('common.cancel')}</button>
          <button className={force ? 'danger' : 'primary'} disabled={!p || (p.commits.length === 0 && !p.newBranch && !force && !tags)} onClick={submit}>
            {t('push.push')}
          </button>
        </>
      }
    >
      {preview.isLoading && <p className="muted">{t('common.loading')}</p>}
      {preview.isError && <p className="error-text">{errorMessage(preview.error)}</p>}
      {p && (
        <div className="push-layout">
          <div className="push-target">
            <Field label={t('push.branch')}>
              <input value={p.branch} readOnly className="mono" />
            </Field>
            <Field label={t('push.remote')}>
              <select value={p.remote} onChange={(e) => setRemote(e.target.value)}>
                {p.remotes.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('push.remoteBranch')}>
              <input
                value={rbInput}
                className="mono"
                onChange={(e) => setRbInput(e.target.value)}
                onBlur={() => rbInput.trim() && rbInput.trim() !== p.remoteBranch && setRemoteBranch(rbInput.trim())}
              />
            </Field>
            <p>
              <strong className="mono">
                {p.branch} → {p.remote}/{p.remoteBranch}
              </strong>{' '}
              <span className="muted">{t('push.commits', { count: p.commits.length })}</span>
            </p>
            {p.newBranch && <p className="info-text">{t('push.newBranch')}</p>}
            {p.behind > 0 && !force && (
              <div className="warn-box">
                <p>{t('push.behind', { count: p.behind })}</p>
                <button
                  onClick={() => {
                    close();
                    void startPull(repoId);
                  }}
                >
                  {t('pull.action')}
                </button>
              </div>
            )}
          </div>
          <div className="push-commits">
            {p.commits.length === 0 ? (
              <p className="muted">{t('push.noCommits')}</p>
            ) : (
              <ul>
                {p.commits.map((c) => (
                  <li key={c.hash}>
                    <span className="mono muted">{c.shortHash}</span> {c.subject}
                    <span className="muted">
                      {' '}
                      · {c.authorName} · {relativeTime(c.authorTime)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
