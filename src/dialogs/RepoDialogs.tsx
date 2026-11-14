// 添加本地仓库（R-01）、克隆（R-02）
import { useEffect, useRef, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { useTranslation } from 'react-i18next';
import { api } from '../api';
import type { CloneReq, CredentialProfile, PathCheck } from '../api/types';
import { CredentialFields, useCredentialForm } from '../components/CredentialFields';
import { cloneRetry, isHttpCredentialUrl, type CloneRetry } from '../lib/credentials';
import { useAuth } from '../stores/authStore';
import { keys, queryClient, reportError } from '../api/queries';
import { useApp } from '../stores/appStore';
import { Field, Modal } from '../components/ui';

async function pickDir(): Promise<string | null> {
  const r = await open({ directory: true, multiple: false });
  return typeof r === 'string' ? r : null;
}

export function AddRepoDialog() {
  const { t } = useTranslation();
  const close = useApp((s) => s.closeDialog);
  const selectRepo = useApp((s) => s.selectRepo);
  const toast = useApp((s) => s.toast);
  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  const [check, setCheck] = useState<PathCheck | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!path.trim()) {
      setCheck(null);
      return;
    }
    const h = setTimeout(() => api.repo.checkPath(path.trim()).then(setCheck, () => setCheck(null)), 250);
    return () => clearTimeout(h);
  }, [path]);

  const submit = async (init: boolean) => {
    setBusy(true);
    try {
      const repo = await api.repo.add(path.trim(), init, name);
      await queryClient.invalidateQueries({ queryKey: keys.repos });
      selectRepo(repo.id);
      toast('success', t('addRepo.added', { name: repo.name }));
      close();
    } catch (e) {
      reportError(e);
    } finally {
      setBusy(false);
    }
  };

  /** 留空时后端使用仓库根目录的文件夹名 */
  const defaultName = (check?.root ?? path.trim()).split(/[\\/]/).filter(Boolean).pop() ?? '';
  const canAdd = check?.exists && check.isRepo && !check.registered;
  return (
    <Modal
      title={t('addRepo.title')}
      onClose={close}
      footer={
        <>
          <button onClick={close}>{t('common.cancel')}</button>
          {check?.exists && !check.isRepo ? (
            <button className="primary" disabled={busy} onClick={() => submit(true)}>
              {t('addRepo.init')}
            </button>
          ) : (
            <button className="primary" disabled={!canAdd || busy} onClick={() => submit(false)}>
              {t('addRepo.add')}
            </button>
          )}
        </>
      }
    >
      <Field label={t('addRepo.path')}>
        <div className="input-row">
          <input value={path} onChange={(e) => setPath(e.target.value)} className="mono" />
          <button onClick={() => pickDir().then((p) => p && setPath(p))}>{t('common.browse')}</button>
        </div>
      </Field>
      <Field label={t('addRepo.name')} hint={t('addRepo.nameHint')}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder={defaultName} />
      </Field>
      {check && !check.exists && <p className="error-text">{t('addRepo.notExist')}</p>}
      {check?.exists && !check.isRepo && <p className="warn-text">{t('addRepo.notRepo')}</p>}
      {check?.registered && <p className="warn-text">{t('addRepo.registered')}</p>}
      {check?.isRepo && check.root && check.root !== path.trim() && !check.registered && <p className="muted">{t('addRepo.subdir', { root: check.root })}</p>}
    </Modal>
  );
}

function nameFromUrl(url: string): string {
  const m = url.trim().replace(/\/+$/, '').match(/([^/:\\]+?)(\.git)?$/);
  return m ? m[1] : '';
}

export function CloneDialog({ initial }: { initial?: CloneRetry }) {
  const { t } = useTranslation();
  const close = useApp((s) => s.closeDialog);
  const toast = useApp((s) => s.toast);
  const settings = useApp((s) => s.settings);
  const initialParts = initial?.dest.match(/^(.*)[\\/]([^\\/]+)$/);
  const [url, setUrl] = useState(initial?.url ?? '');
  const [parent, setParent] = useState(initialParts?.[1] ?? settings.cloneParent ?? '');
  const [dirName, setDirName] = useState(initialParts?.[2] ?? '');
  const [dirTouched, setDirTouched] = useState(!!initial);
  const [name, setName] = useState(initial?.name ?? '');
  const [branch, setBranch] = useState(initial?.branch ?? '');
  const [depth, setDepth] = useState(initial?.depth?.toString() ?? '');
  const [profiles, setProfiles] = useState<CredentialProfile[]>([]);
  const [profileError, setProfileError] = useState(false);
  const [submitError, setSubmitError] = useState(false);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const auth = useCredentialForm(url);
  const https = isHttpCredentialUrl(url);

  useEffect(() => {
    let disposed = false;
    api.credential.list().then((items) => { if (!disposed) setProfiles(items); }, () => { if (!disposed) setProfileError(true); });
    return () => { disposed = true; };
  }, []);

  useEffect(() => {
    if (!dirTouched) setDirName(nameFromUrl(url));
  }, [url, dirTouched]);

  const sep = parent.includes('\\') ? '\\' : '/';
  const dest = parent && dirName ? `${parent.replace(/[\\/]+$/, '')}${sep}${dirName}` : '';

  const closeIfIdle = () => { if (!submitting.current) close(); };
  const authValid = !https || auth.choice !== 'other' || (!!auth.username.trim() && !!auth.secret);
  const submit = async () => {
    if (submitting.current || !authValid || !url.trim() || !dest) return;
    submitting.current = true;
    setBusy(true);
    setSubmitError(false);
    const req: CloneReq = { url: url.trim(), dest, branch: branch.trim() || null, depth: depth ? Number(depth) : null, name };
    if (https && auth.choice === 'other') {
      req.credential = { username: auth.username.trim(), secret: auth.secret, remember: auth.remember, name: auth.name.trim() || undefined };
    } else if (https && auth.choice !== 'auto') {
      req.credentialId = auth.choice;
    }
    try {
      const id = await api.task.clone(req);
      useAuth.getState().rememberClone(id, cloneRetry(req));
      auth.setSecret('');
      void api.settings.set('cloneParent', parent);
      useApp.getState().patchSetting('cloneParent', parent);
      useApp.getState().setBottom(true, 'tasks');
      toast('info', t('clone.started', { name: name.trim() || dirName }));
      close();
    } catch {
      // Credential-bearing requests must never populate global toasts with raw errors.
      auth.setSecret('');
      setSubmitError(true);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  return (
    <Modal
      title={t('clone.title')}
      onClose={closeIfIdle}
      width={560}
      footer={
        <>
          <button disabled={busy} onClick={closeIfIdle}>{t('common.cancel')}</button>
          <button className="primary" disabled={!url.trim() || !dest || !authValid || busy} onClick={submit}>
            {t('clone.start')}
          </button>
        </>
      }
    >
      {submitError && <p className="error-text" role="alert">{t('auth.cloneFailed')}</p>}
      <Field label={t('clone.url')} hint={t('clone.tokenNote')}>
        <input value={url} onChange={(e) => setUrl(e.target.value)} className="mono" placeholder="git@host:group/repo.git" />
      </Field>
      {https ? <>
        <CredentialFields url={url} profiles={profiles} form={auth} disabled={busy} />
        {profileError && <p className="warn-text">{t('auth.profilesUnavailable')}</p>}
      </> : <p className="muted small-text">{t(/^http:\/\//i.test(url.trim()) ? 'auth.httpNote' : 'auth.sshNote')}</p>}
      <Field label={t('clone.parent')}>
        <div className="input-row">
          <input value={parent} onChange={(e) => setParent(e.target.value)} className="mono" />
          <button onClick={() => pickDir().then((p) => p && setParent(p))}>{t('common.browse')}</button>
        </div>
      </Field>
      <Field label={t('clone.dirName')} hint={dest && <span className="mono">{dest}</span>}>
        <input
          value={dirName}
          onChange={(e) => {
            setDirTouched(true);
            setDirName(e.target.value);
          }}
          className="mono"
        />
      </Field>
      <Field label={t('clone.name')} hint={t('clone.nameHint')}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder={dirName} />
      </Field>
      <div className="field-row">
        <Field label={t('clone.branch')}>
          <input value={branch} onChange={(e) => setBranch(e.target.value)} className="mono" />
        </Field>
        <Field label={t('clone.depth')}>
          <input type="number" min={0} value={depth} onChange={(e) => setDepth(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}
