// 添加本地仓库（R-01）、克隆（R-02）
import { useEffect, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { useTranslation } from 'react-i18next';
import { api } from '../api';
import type { PathCheck } from '../api/types';
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
      const repo = await api.repo.add(path.trim(), init);
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

export function CloneDialog() {
  const { t } = useTranslation();
  const close = useApp((s) => s.closeDialog);
  const toast = useApp((s) => s.toast);
  const settings = useApp((s) => s.settings);
  const [url, setUrl] = useState('');
  const [parent, setParent] = useState(settings.cloneParent ?? '');
  const [dirName, setDirName] = useState('');
  const [dirTouched, setDirTouched] = useState(false);
  const [branch, setBranch] = useState('');
  const [depth, setDepth] = useState('');

  useEffect(() => {
    if (!dirTouched) setDirName(nameFromUrl(url));
  }, [url, dirTouched]);

  const sep = parent.includes('\\') ? '\\' : '/';
  const dest = parent && dirName ? `${parent.replace(/[\\/]+$/, '')}${sep}${dirName}` : '';

  const submit = async () => {
    try {
      await api.task.clone({ url: url.trim(), dest, branch: branch.trim() || null, depth: depth ? Number(depth) : null });
      void api.settings.set('cloneParent', parent);
      useApp.getState().patchSetting('cloneParent', parent);
      useApp.getState().setBottom(true, 'tasks');
      toast('info', t('clone.started', { name: dirName }));
      close();
    } catch (e) {
      reportError(e);
    }
  };

  return (
    <Modal
      title={t('clone.title')}
      onClose={close}
      width={560}
      footer={
        <>
          <button onClick={close}>{t('common.cancel')}</button>
          <button className="primary" disabled={!url.trim() || !dest} onClick={submit}>
            {t('clone.start')}
          </button>
        </>
      }
    >
      <Field label={t('clone.url')} hint={t('clone.tokenNote')}>
        <input value={url} onChange={(e) => setUrl(e.target.value)} className="mono" placeholder="git@host:group/repo.git" />
      </Field>
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
