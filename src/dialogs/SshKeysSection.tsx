import { useEffect, useRef, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { useTranslation } from 'react-i18next';
import { api } from '../api';
import type { SshKeyInfo } from '../api/types';
import { Field } from '../components/ui';
import { useApp } from '../stores/appStore';

/** Only public material leaves the backend. Passphrases stay in form-local state. */
export function SshKeysSection() {
  const { t } = useTranslation();
  const [keys, setKeys] = useState<SshKeyInfo[]>([]);
  const [directory, setDirectory] = useState('~/.ssh');
  const [selected, setSelected] = useState<SshKeyInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('id_ed25519');
  const [comment, setComment] = useState('GitManagement');
  const [phrase, setPhrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const [unprotected, setUnprotected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [config, setConfig] = useState(false);
  const [host, setHost] = useState('github.com');
  const submitting = useRef(false);

  const showError = (value: unknown, fallback: string) => {
    const code = typeof value === 'object' && value && 'code' in value ? String(value.code) : '';
    const key = `errors.${code}`;
    setError(code.startsWith('sshKeys.') && t(key) !== key ? t(key) : t(fallback));
  };
  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const [items, path] = await Promise.all([api.sshKeys.list(), api.sshKeys.directory()]);
      setKeys(items);
      setDirectory(path);
      setSelected((prev) => prev ? items.find((item) => item.publicPath === prev.publicPath) ?? prev : null);
    } catch (e) { showError(e, 'sshKeys.loadFailed'); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, []);

  const clearSecrets = () => { setPhrase(''); setConfirm(''); setUnprotected(false); };
  const select = (key: SshKeyInfo) => { setSelected(key); setConfig(false); };
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      useApp.getState().toast('success', t('sshKeys.copied'));
    } catch { setError(t('sshKeys.copyFailed')); }
  };
  const generate = async () => {
    if (submitting.current || !valid) return;
    submitting.current = true;
    setBusy(true);
    setError('');
    const passphrase = unprotected ? '' : phrase;
    clearSecrets();
    try {
      const result = await api.sshKeys.generate({ name: name.trim(), comment: comment.trim(), passphrase });
      setKeys((items) => [...items.filter((item) => item.publicPath !== result.publicPath), result]);
      select(result);
      setEditing(false);
      useApp.getState().toast('success', t('sshKeys.generated'));
    } catch (e) { showError(e, 'sshKeys.generateFailed'); }
    finally { submitting.current = false; setBusy(false); }
  };
  const importPublic = async () => {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError('');
    try {
      const path = await open({ multiple: false, directory: false, filters: [{ name: t('sshKeys.publicKey'), extensions: ['pub'] }] });
      if (typeof path === 'string') {
        const result = await api.sshKeys.readPublic(path);
        setKeys((items) => [...items.filter((item) => item.publicPath !== result.publicPath), result]);
        select(result);
      }
    } catch (e) { showError(e, 'sshKeys.loadFailed'); }
    finally { submitting.current = false; setBusy(false); }
  };
  const exists = keys.some((key) => key.name === name.trim() || key.publicPath.endsWith(`/${name.trim()}.pub`));
  const valid = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name.trim()) && !name.trim().endsWith('.pub') && !exists
    && (unprotected || (!!phrase && phrase === confirm));
  const configText = selected?.privatePath && /^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(host.trim())
    ? `Host ${host.trim()}\n    HostName ${host.trim()}\n    User git\n    IdentityFile "${selected.privatePath.replace(/\\/g, '/').replace(/"/g, '\\"')}"\n    IdentitiesOnly yes\n`
    : '';

  return <>
    <p className="muted">{t('sshKeys.intro')}</p>
    <p className="mono small-text">{directory}</p>
    <div className="action-row">
      <button disabled={busy || loading} className="primary" onClick={() => { clearSecrets(); setError(''); setEditing(true); }}>{t('sshKeys.generate')}</button>
      <button disabled={busy} onClick={() => void importPublic()}>{t('sshKeys.readExisting')}</button>
      <button disabled={busy || loading} onClick={() => void load()}>{t('common.refresh')}</button>
    </div>
    {error && <p className="error-text" role="alert">{error}</p>}
    {loading ? <p className="muted">{t('common.loading')}</p> : !keys.length ? <p className="muted">{t('sshKeys.empty')}</p> : <ul className="credential-list">
      {keys.map((key) => <li key={key.publicPath}>
        <div className="credential-summary"><strong>{key.name}</strong><span className="mono muted">{key.fingerprint}</span><span className="mono muted">{key.publicPath}</span></div>
        <button disabled={busy} onClick={() => select(key)} aria-label={t('sshKeys.viewNamed', { name: key.name })}>{t('sshKeys.view')}</button>
        <button disabled={busy} onClick={() => void copy(key.publicKey)} aria-label={t('sshKeys.copyNamed', { name: key.name })}>{t('sshKeys.copy')}</button>
      </li>)}
    </ul>}
    {editing && <fieldset disabled={busy}>
      <legend>{t('sshKeys.generate')}</legend>
      <p className="muted small-text">{t('sshKeys.algorithm')}</p>
      <Field label={t('sshKeys.filename')} hint={exists ? t('sshKeys.exists') : `${directory}/${name}`}>
        <input aria-label={t('sshKeys.filename')} value={name} onChange={(e) => setName(e.target.value)} className="mono" autoComplete="off" />
      </Field>
      <Field label={t('sshKeys.comment')}><input value={comment} onChange={(e) => setComment(e.target.value)} /></Field>
      {!unprotected && <div className="field-row">
        <Field label={t('sshKeys.passphrase')}><input type="password" autoComplete="new-password" value={phrase} onChange={(e) => setPhrase(e.target.value)} /></Field>
        <Field label={t('sshKeys.confirm')} hint={confirm && phrase !== confirm ? t('sshKeys.mismatch') : undefined}><input aria-label={t('sshKeys.confirm')} type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} /></Field>
      </div>}
      <label className="check"><input type="checkbox" checked={unprotected} onChange={(e) => { setUnprotected(e.target.checked); setPhrase(''); setConfirm(''); }} />{t('sshKeys.unprotected')}</label>
      {unprotected && <p className="warn-text">{t('sshKeys.unprotectedWarning')}</p>}
      <p className="muted small-text">{t('sshKeys.noOverwrite')}</p>
      <div className="action-row">
        <button className="primary" disabled={!valid} onClick={() => void generate()}>{busy ? t('sshKeys.generating') : t('sshKeys.generatePair')}</button>
        <button onClick={() => { clearSecrets(); setEditing(false); }}>{t('common.cancel')}</button>
      </div>
    </fieldset>}
    {selected && <fieldset>
      <legend>{t('sshKeys.publicKey')} · {selected.name}</legend>
      <p className="mono small-text">{selected.keyType} · {selected.fingerprint}</p>
      <Field label={t('sshKeys.publicKey')}><textarea aria-label={t('sshKeys.publicKey')} className="mono" style={{ width: '100%', display: 'block', minWidth: 0 }} rows={4} readOnly value={selected.publicKey} onFocus={(e) => e.target.select()} /></Field>
      <button onClick={() => void copy(selected.publicKey)}>{t('sshKeys.copy')}</button>
      <p>{t('sshKeys.whereToAdd')}</p>
      <p className="warn-text small-text">{t('sshKeys.privateWarning')}</p>
      {selected.privatePath && <>
        <p className="muted small-text">{t('sshKeys.usage')}</p>
        <button onClick={() => setConfig(!config)}>{t('sshKeys.configExample')}</button>
        {config && <>
          <Field label={t('sshKeys.host')}><input className="mono" value={host} onChange={(e) => setHost(e.target.value)} placeholder="github.com" /></Field>
          {configText && <><pre className="mono auth-url">{configText}</pre><button onClick={() => void copy(configText)}>{t('sshKeys.copyConfig')}</button></>}
          <p className="muted small-text">{t('sshKeys.configWarning')}</p>
        </>}
      </>}
    </fieldset>}
  </>;
}
