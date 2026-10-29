// 新建 Stash（C-10）：全部改动或仅所选文件，可包含未跟踪文件
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api';
import { invalidateRepo, reportError, useStatus } from '../api/queries';
import { useApp } from '../stores/appStore';
import { Field, Modal } from '../components/ui';

export function StashCreateDialog({ repoId, paths }: { repoId: string; paths: string[] }) {
  const { t } = useTranslation();
  const close = useApp((s) => s.closeDialog);
  const toast = useApp((s) => s.toast);
  const status = useStatus(repoId);
  const [message, setMessage] = useState('');
  const [onlySelected, setOnlySelected] = useState(paths.length > 0);
  const [untracked, setUntracked] = useState(paths.length > 0 && paths.some((p) => status.data?.files.find((f) => f.path === p)?.kind === 'untracked'));
  const [keepIndex, setKeepIndex] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      await api.stash.create(repoId, { message, paths: onlySelected ? paths : [], includeUntracked: untracked, keepIndex });
      toast('success', t('stash.created'));
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
      title={t('stash.createTitle')}
      onClose={close}
      footer={
        <>
          <button onClick={close}>{t('common.cancel')}</button>
          <button className="primary" disabled={busy} onClick={() => void submit()}>
            {t('stash.create')}
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
        <Field label={t('stash.message')}>
          <input value={message} onChange={(e) => setMessage(e.target.value)} placeholder={t('stash.messagePlaceholder')} />
        </Field>
      </form>
      {paths.length > 0 && (
        <label className="check">
          <input type="checkbox" checked={onlySelected} onChange={(e) => setOnlySelected(e.target.checked)} />
          {t('stash.onlySelected', { count: paths.length })}
        </label>
      )}
      <label className="check">
        <input type="checkbox" checked={untracked} onChange={(e) => setUntracked(e.target.checked)} />
        {t('stash.includeUntracked')}
      </label>
      <label className="check">
        <input type="checkbox" checked={keepIndex} onChange={(e) => setKeepIndex(e.target.checked)} />
        {t('stash.keepIndex')}
      </label>
      {onlySelected && paths.length > 0 && (
        <ul className="confirm-items">
          {paths.slice(0, 30).map((p) => (
            <li key={p} className="mono">
              {p}
            </li>
          ))}
          {paths.length > 30 && <li>… +{paths.length - 30}</li>}
        </ul>
      )}
    </Modal>
  );
}
