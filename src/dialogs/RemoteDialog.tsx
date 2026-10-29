// 添加 / 编辑 Remote（M-01）
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api';
import type { RemoteInfo } from '../api/types';
import { invalidateRepo, reportError } from '../api/queries';
import { Field, Modal } from '../components/ui';
import { Icon } from '../components/Icon';

export function RemoteDialog({ repoId, remote, onClose }: { repoId: string; remote: RemoteInfo | null; onClose: () => void }) {
  const { t } = useTranslation();
  const [name, setName] = useState(remote?.name ?? '');
  const [fetchUrl, setFetchUrl] = useState(remote?.fetchUrl ?? '');
  const [pushUrls, setPushUrls] = useState<string[]>(remote?.pushUrls ?? []);
  const [busy, setBusy] = useState(false);
  // 已脱敏的 URL（含 ***）不能原样写回
  const redacted = fetchUrl.includes('***@') || pushUrls.some((u) => u.includes('***@'));

  const submit = async () => {
    setBusy(true);
    try {
      const input = { name: name.trim(), fetchUrl: fetchUrl.trim(), pushUrls: pushUrls.map((u) => u.trim()).filter(Boolean) };
      if (remote) await api.remoteAdmin.update(repoId, remote.name, input);
      else await api.remoteAdmin.add(repoId, input);
      invalidateRepo(repoId);
      onClose();
    } catch (e) {
      reportError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={remote ? t('mapping.editRemote', { name: remote.name }) : t('mapping.addRemote')}
      onClose={onClose}
      width={560}
      footer={
        <>
          <button onClick={onClose}>{t('common.cancel')}</button>
          <button className="primary" disabled={!name.trim() || !fetchUrl.trim() || busy || redacted} onClick={submit}>
            {t('common.save')}
          </button>
        </>
      }
    >
      <Field label={t('mapping.colName')}>
        <input value={name} onChange={(e) => setName(e.target.value)} className="mono" placeholder="origin" />
      </Field>
      <Field label="Fetch URL" hint={t('clone.tokenNote')}>
        <input value={fetchUrl} onChange={(e) => setFetchUrl(e.target.value)} className="mono" placeholder="git@host:group/repo.git" />
      </Field>
      <Field label="Push URL" hint={t('mapping.pushUrlHint')}>
        <div className="stack">
          {pushUrls.map((u, i) => (
            <div className="input-row" key={i}>
              <input value={u} className="mono" onChange={(e) => setPushUrls(pushUrls.map((x, k) => (k === i ? e.target.value : x)))} />
              <button className="icon-btn" aria-label={t('common.delete')} onClick={() => setPushUrls(pushUrls.filter((_, k) => k !== i))}>
                <Icon name="close" />
              </button>
            </div>
          ))}
          <button className="small" onClick={() => setPushUrls([...pushUrls, ''])}>
            + {t('mapping.addPushUrl')}
          </button>
        </div>
      </Field>
      {redacted && <p className="warn-text">{t('mapping.redactedUrl')}</p>}
    </Modal>
  );
}
