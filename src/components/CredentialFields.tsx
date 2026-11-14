import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CredentialProfile } from '../api/types';
import { credentialOrigin, matchingProfiles } from '../lib/credentials';
import { Field } from './ui';

/** Form-local only, including the secret; never persisted or passed to app stores. */
export function useCredentialForm(url: string, initialUsername = '') {
  const [choice, setChoice] = useState('auto');
  const [username, setUsername] = useState(initialUsername);
  const [secret, setSecret] = useState('');
  const [remember, setRemember] = useState(false);
  const [name, setName] = useState('');
  const origin = credentialOrigin(url);
  let urlUsername = '';
  try { urlUsername = decodeURIComponent(new URL(url.trim()).username); } catch { /* Not an HTTP(S) URL yet. */ }
  const usernameHint = initialUsername || urlUsername;
  useEffect(() => {
    setChoice('auto');
    setUsername(usernameHint);
    setSecret('');
    setRemember(false);
    setName('');
  }, [origin, usernameHint]);
  return { choice, setChoice, username, setUsername, secret, setSecret, remember, setRemember, name, setName };
}

export function CredentialFields({ url, profiles, form, automatic = true, disabled = false }: {
  url: string;
  profiles: CredentialProfile[];
  form: ReturnType<typeof useCredentialForm>;
  automatic?: boolean;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const matches = matchingProfiles(url, profiles);
  const choice = !automatic && form.choice === 'auto' ? 'other' : form.choice;
  return (
    <fieldset disabled={disabled} className="credential-fields">
      <legend>{t('auth.authentication')}</legend>
      <Field label={t('auth.account')}>
        <select value={choice} onChange={(e) => {
          form.setChoice(e.target.value);
          form.setSecret('');
          form.setRemember(false);
        }}>
          {automatic && <option value="auto">{t('auth.automatic')}</option>}
          {matches.map((profile) => <option key={profile.id} value={profile.id}>{profile.name} — {profile.username}</option>)}
          <option value="other">{t('auth.other')}</option>
        </select>
      </Field>
      {choice === 'other' && <>
        <div className="field-row">
          <Field label={t('settings.credUser')}>
            <input autoComplete="off" value={form.username} onChange={(e) => form.setUsername(e.target.value)} />
          </Field>
          <Field label={t('settings.credToken')}>
            <input type="password" autoComplete="new-password" value={form.secret} onChange={(e) => form.setSecret(e.target.value)} />
          </Field>
        </div>
        <label className="check">
          <input type="checkbox" checked={form.remember} onChange={(e) => form.setRemember(e.target.checked)} />
          {t('auth.remember')}
        </label>
        {form.remember && <Field label={t('auth.profileName')}>
          <input value={form.name} onChange={(e) => form.setName(e.target.value)} placeholder={form.username} />
        </Field>}
      </>}
      <p className="muted small-text">{t('auth.httpsNote')}</p>
      {credentialOrigin(url)?.startsWith('http://') && <p className="warn-text small-text" role="note">{t('auth.httpNote')}</p>}
    </fieldset>
  );
}
