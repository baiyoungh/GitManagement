import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api';
import type { CredentialProfile } from '../api/types';
import { Field } from '../components/ui';
import { useApp } from '../stores/appStore';
import { credentialOrigin, isHttpCredentialUrl } from '../lib/credentials';

export function CredentialSection() {
  const { t } = useTranslation();
  const [profiles, setProfiles] = useState<CredentialProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [editing, setEditing] = useState<CredentialProfile | 'new' | null>(null);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [username, setUsername] = useState('');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  useEffect(() => {
    let disposed = false;
    api.credential.list().then((items) => { if (!disposed) setProfiles(items); }, () => { if (!disposed) setFailed(true); })
      .finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; };
  }, []);
  const edit = (profile: CredentialProfile | 'new' | null) => {
    setEditing(profile);
    setName(profile && profile !== 'new' ? profile.name : '');
    setUrl(profile && profile !== 'new' ? profile.url : '');
    setUsername(profile && profile !== 'new' ? profile.username : '');
    setSecret('');
    setFailed(false);
  };
  const save = async () => {
    if (submitting.current || !editing) return;
    submitting.current = true;
    setBusy(true);
    setFailed(false);
    try {
      const saved = await api.credential.upsert({
        id: editing === 'new' ? null : editing.id, name: name.trim(), url: credentialOrigin(url)!, username: username.trim(),
        secret: secret || null,
      });
      setProfiles((items) => [...items.filter((profile) => profile.id !== saved.id), saved]);
      edit(null);
      useApp.getState().toast('success', t('settings.credSaved'));
    } catch {
      setFailed(true);
      setSecret('');
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };
  const remove = async (profile: CredentialProfile) => {
    if (submitting.current) return;
    if (!await useApp.getState().ask({ title: t('settings.credDelete'), body: t('auth.deleteBody', { name: profile.name }), danger: true })) return;
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    try {
      await api.credential.remove(profile.id);
      setProfiles((items) => items.filter((item) => item.id !== profile.id));
      if (editing && editing !== 'new' && editing.id === profile.id) edit(null);
      useApp.getState().toast('success', t('settings.credDeleted'));
    } catch { setFailed(true); }
    finally { submitting.current = false; setBusy(false); }
  };
  return <>
    <p className="muted">{t('settings.credNote')}</p>
    {loading ? <p className="muted">{t('common.loading')}</p> : <>
      {!profiles.length && <p className="muted">{t('auth.empty')}</p>}
      {profiles.length > 0 && <ul className="credential-list">
        {profiles.map((profile) => <li key={profile.id}>
          <div className="credential-summary"><strong>{profile.name}</strong><span>{profile.username}</span><span className="mono muted">{profile.url}</span></div>
          <button disabled={busy} onClick={() => edit(profile)} aria-label={t('auth.editNamed', { name: profile.name })}>{t('auth.edit')}</button>
          <button disabled={busy} className="danger" onClick={() => void remove(profile)} aria-label={t('auth.deleteNamed', { name: profile.name })}>{t('common.delete')}</button>
        </li>)}
      </ul>}
      <button disabled={busy} onClick={() => edit('new')}>{t('auth.add')}</button>
    </>}
    {failed && <p className="error-text" role="alert">{t('auth.profileFailed')}</p>}
    {editing && <fieldset disabled={busy}>
      <legend>{t(editing === 'new' ? 'auth.add' : 'auth.edit')}</legend>
      <Field label={t('auth.profileName')}><input value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label={t('settings.credUrl')} hint={url && !isHttpCredentialUrl(url) ? t('auth.httpsOnly') : undefined}><input className="mono" value={url} onChange={(e) => setUrl(e.target.value)} /></Field>
      {credentialOrigin(url)?.startsWith('http://') && <p className="warn-text small-text">{t('auth.httpNote')}</p>}
      <Field label={t('settings.credUser')}><input autoComplete="off" value={username} onChange={(e) => setUsername(e.target.value)} /></Field>
      <Field label={t('settings.credToken')} hint={editing !== 'new' ? t('auth.keepSecret') : undefined}>
        <input type="password" autoComplete="new-password" value={secret} onChange={(e) => setSecret(e.target.value)} />
      </Field>
      <div className="action-row">
        <button disabled={!name.trim() || !isHttpCredentialUrl(url) || !username.trim() || (editing === 'new' && !secret)} className="primary" onClick={() => void save()}>{t('common.save')}</button>
        <button onClick={() => edit(null)}>{t('common.cancel')}</button>
      </div>
    </fieldset>}
    <p className="muted small-text">{t('auth.sshNote')}</p>
  </>;
}
