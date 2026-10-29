// 新建标签（B-08）：轻量 / 附注，可选立即推送
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api';
import { invalidateRepo, reportError, useRemotes } from '../api/queries';
import { useApp } from '../stores/appStore';
import { Field, Modal } from '../components/ui';

export function TagDialog({ repoId, target, label }: { repoId: string; target: string; label?: string }) {
  const { t } = useTranslation();
  const close = useApp((s) => s.closeDialog);
  const toast = useApp((s) => s.toast);
  const remotes = useRemotes(repoId);
  const [name, setName] = useState('');
  const [message, setMessage] = useState('');
  const [push, setPush] = useState(false);
  const [remote, setRemote] = useState('');
  const [busy, setBusy] = useState(false);
  const remoteName = remote || remotes.data?.find((r) => r.name === 'origin')?.name || remotes.data?.[0]?.name || '';

  const submit = async () => {
    const n = name.trim();
    if (!n) return;
    setBusy(true);
    try {
      await api.history.createTag(repoId, n, target, message.trim() || null);
      toast('success', t('log.tagCreated', { name: n }));
      if (push && remoteName) {
        await api.tag.push(repoId, remoteName, n);
        useApp.getState().setBottom(true, 'tasks');
      }
      close();
    } catch (e) {
      reportError(e);
    } finally {
      setBusy(false);
      invalidateRepo(repoId);
    }
  };

  return (
    <Modal
      title={t('tags.createTitle', { target: label ?? target.slice(0, 10) })}
      onClose={close}
      footer={
        <>
          <button onClick={close}>{t('common.cancel')}</button>
          <button className="primary" disabled={busy || !name.trim()} onClick={() => void submit()}>
            {t('tags.create')}
          </button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label={t('tags.name')}>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="v1.0.0" />
        </Field>
        <Field label={t('tags.message')} hint={t('tags.messageHint')}>
          <textarea rows={3} value={message} onChange={(e) => setMessage(e.target.value)} />
        </Field>
      </form>
      <div className="input-row">
        <label className="check">
          <input type="checkbox" checked={push} disabled={!remotes.data?.length} onChange={(e) => setPush(e.target.checked)} />
          {t('tags.pushAfter')}
        </label>
        {push && (
          <select value={remoteName} onChange={(e) => setRemote(e.target.value)} aria-label={t('push.remote')}>
            {(remotes.data ?? []).map((r) => (
              <option key={r.name}>{r.name}</option>
            ))}
          </select>
        )}
      </div>
    </Modal>
  );
}
