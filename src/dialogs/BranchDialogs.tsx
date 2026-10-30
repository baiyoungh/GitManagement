// 新建 / 重命名 / 删除分支、设置 upstream（B-02、B-04、M-02）
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api';
import { invalidateRepo, reportError, useBranches, useRemotes } from '../api/queries';
import { useApp } from '../stores/appStore';
import { Field, Modal } from '../components/ui';
import { isAppError } from '../lib/errors';

export function CreateBranchDialog({ repoId, startPoint }: { repoId: string; startPoint?: string }) {
  const { t } = useTranslation();
  const close = useApp((s) => s.closeDialog);
  const toast = useApp((s) => s.toast);
  const remotes = useRemotes(repoId);
  const branches = useBranches(repoId);
  const [name, setName] = useState('');
  const [source, setSource] = useState(startPoint ?? 'HEAD');
  const [custom, setCustom] = useState('');
  const [checkout, setCheckout] = useState(true);
  const [withUpstream, setWithUpstream] = useState(false);
  const [remote, setRemote] = useState('');
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const remoteName = remote || remotes.data?.[0]?.name || '';
  const list = branches.data ?? [];
  const duplicate = list.some((b) => b.kind === 'local' && b.name === name.trim());
  const start = source === 'custom' ? custom.trim() : source;
  const valid = !!name.trim() && !!start && !duplicate;

  const submit = async () => {
    if (!valid || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    try {
      await api.branch.create(repoId, {
        name: name.trim(),
        startPoint: start === 'HEAD' ? null : start,
        checkout,
        upstream: withUpstream && remoteName ? { remote: remoteName, branch: name.trim() } : null,
      });
      toast('success', t('branches.created', { name: name.trim() }));
      close();
    } catch (e) {
      reportError(e);
    } finally {
      submitting.current = false;
      setBusy(false);
      invalidateRepo(repoId);
    }
  };

  return (
    <Modal
      title={t('branchDialog.createTitle')}
      onClose={close}
      footer={
        <>
          <button onClick={close}>{t('common.cancel')}</button>
          <button className="primary" disabled={!valid || busy} onClick={submit}>
            {t('common.ok')}
          </button>
        </>
      }
    >
      <form className="branch-create-form" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <Field label={t('branchDialog.name')} hint={duplicate ? <span className="error-text">{t('branchDialog.duplicate')}</span> : undefined}>
        <input value={name} onChange={(e) => setName(e.target.value)} className="mono" disabled={busy} />
      </Field>
      <Field label={t('branchDialog.source')}>
        <select value={source} onChange={(e) => setSource(e.target.value)} disabled={busy}>
          <option value="HEAD">{t('branchDialog.head')}</option>
          {source !== 'HEAD' && source !== 'custom' && !list.some((b) => b.fullRef === source) && <option value={source}>{source}</option>}
          {(['local', 'remote'] as const).map((kind) => <optgroup key={kind} label={t(`branches.${kind}`)}>
            {list.filter((b) => b.kind === kind).map((b) => <option key={b.fullRef} value={b.fullRef}>{b.name}</option>)}
          </optgroup>)}
          <option value="custom">{t('branchDialog.custom')}</option>
        </select>
      </Field>
      {source === 'custom' && <Field label={t('branchDialog.revision')}>
        <input className="mono" value={custom} onChange={(e) => setCustom(e.target.value)} disabled={busy} placeholder="v1.0 / a1b2c3d" />
      </Field>}
      <label className="check">
        <input type="checkbox" checked={checkout} onChange={(e) => setCheckout(e.target.checked)} />
        {t('branchDialog.checkoutAfter')}
      </label>
      {(remotes.data?.length ?? 0) > 0 && (
        <div className="input-row">
          <label className="check">
            <input type="checkbox" checked={withUpstream} onChange={(e) => setWithUpstream(e.target.checked)} />
            {t('branchDialog.setUpstreamAfter')}
          </label>
          <select value={remoteName} onChange={(e) => setRemote(e.target.value)} disabled={!withUpstream}>
            {remotes.data?.map((r) => (
              <option key={r.name} value={r.name}>
                {r.name}
              </option>
            ))}
          </select>
          <span className="mono muted">/{name.trim() || '…'}</span>
        </div>
      )}
      <button type="submit" hidden disabled={!valid || busy} />
      </form>
    </Modal>
  );
}

export function RenameBranchDialog({ repoId, name }: { repoId: string; name: string }) {
  const { t } = useTranslation();
  const close = useApp((s) => s.closeDialog);
  const toast = useApp((s) => s.toast);
  const [value, setValue] = useState(name);
  const submit = async () => {
    try {
      await api.branch.rename(repoId, name, value.trim());
      toast('success', t('branches.renamed', { name: value.trim() }));
      close();
    } catch (e) {
      reportError(e);
    } finally {
      invalidateRepo(repoId);
    }
  };
  return (
    <Modal
      title={t('branchDialog.renameTitle', { name })}
      onClose={close}
      footer={
        <>
          <button onClick={close}>{t('common.cancel')}</button>
          <button className="primary" disabled={!value.trim() || value.trim() === name} onClick={submit}>
            {t('common.ok')}
          </button>
        </>
      }
    >
      <Field label={t('branchDialog.newName')}>
        <input value={value} onChange={(e) => setValue(e.target.value)} className="mono" />
      </Field>
    </Modal>
  );
}

export function UpstreamDialog({ repoId, name }: { repoId: string; name: string }) {
  const { t } = useTranslation();
  const close = useApp((s) => s.closeDialog);
  const toast = useApp((s) => s.toast);
  const remotes = useRemotes(repoId);
  const branches = useBranches(repoId);
  const current = branches.data?.find((b) => b.kind === 'local' && b.name === name);
  const [remote, setRemote] = useState(current?.upstreamRemote ?? '');
  const [rb, setRb] = useState(current?.upstreamBranch ?? name);
  const remoteName = remote || remotes.data?.[0]?.name || '';
  const suggestions = branches.data?.filter((b) => b.kind === 'remote' && b.remote === remoteName).map((b) => b.remoteBranch ?? '') ?? [];

  const submit = async () => {
    try {
      await api.branch.setUpstream(repoId, name, remoteName, rb.trim());
      toast('success', t('branches.upstreamSet'));
      close();
    } catch (e) {
      reportError(e);
    } finally {
      invalidateRepo(repoId);
    }
  };

  return (
    <Modal
      title={t('branchDialog.upstreamTitle', { name })}
      onClose={close}
      footer={
        <>
          <button onClick={close}>{t('common.cancel')}</button>
          <button className="primary" disabled={!remoteName || !rb.trim()} onClick={submit}>
            {t('common.ok')}
          </button>
        </>
      }
    >
      <div className="field-row">
        <Field label={t('branchDialog.remote')}>
          <select value={remoteName} onChange={(e) => setRemote(e.target.value)}>
            {remotes.data?.map((r) => (
              <option key={r.name} value={r.name}>
                {r.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('branchDialog.remoteBranch')}>
          <input value={rb} onChange={(e) => setRb(e.target.value)} className="mono" list="upstream-suggestions" />
          <datalist id="upstream-suggestions">
            {suggestions.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </Field>
      </div>
    </Modal>
  );
}

export function DeleteBranchDialog({ repoId, name, upstream }: { repoId: string; name: string; upstream?: { remote: string; branch: string } | null }) {
  const { t } = useTranslation();
  const close = useApp((s) => s.closeDialog);
  const ask = useApp((s) => s.ask);
  const toast = useApp((s) => s.toast);
  const [alsoRemote, setAlsoRemote] = useState(false);
  const [busy, setBusy] = useState(false);

  const run = async (force: boolean): Promise<void> => {
    setBusy(true);
    try {
      await api.branch.delete(repoId, { name, force, remote: alsoRemote && upstream ? upstream : null });
      toast('success', t('branches.deleted', { name }));
      close();
    } catch (e) {
      if (!force && isAppError(e) && e.code === 'git.branchNotMerged') {
        setBusy(false);
        const ok = await ask({
          title: t('deleteBranch.notMergedTitle'),
          body: t('deleteBranch.notMergedBody', { name }),
          note: t('common.irreversible'),
          danger: true,
          confirmLabel: t('deleteBranch.forceDelete'),
        });
        if (ok) return run(true);
        return;
      }
      reportError(e);
    } finally {
      setBusy(false);
      invalidateRepo(repoId);
    }
  };

  const confirmDelete = async () => {
    if (alsoRemote && upstream) {
      const ok = await ask({
        title: t('deleteBranch.remoteTitle', { name: `${upstream.remote}/${upstream.branch}` }),
        body: t('deleteBranch.remoteBody', { name: `${upstream.remote}/${upstream.branch}` }),
        note: t('common.irreversible'),
        danger: true,
        confirmLabel: t('common.delete'),
      });
      if (!ok) return;
    }
    await run(false);
  };

  return (
    <Modal
      title={t('deleteBranch.title', { name })}
      onClose={close}
      footer={
        <>
          <button onClick={close}>{t('common.cancel')}</button>
          <button className="danger" disabled={busy} onClick={confirmDelete}>
            {t('common.delete')}
          </button>
        </>
      }
    >
      <p>{t('deleteBranch.body', { name })}</p>
      {upstream && (
        <label className="check">
          <input type="checkbox" checked={alsoRemote} onChange={(e) => setAlsoRemote(e.target.checked)} />
          {t('deleteBranch.alsoRemote', { remote: `${upstream.remote}/${upstream.branch}` })}
        </label>
      )}
    </Modal>
  );
}
