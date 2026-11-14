import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api';
import type { AuthChallenge } from '../api/types';
import { CredentialFields, useCredentialForm } from '../components/CredentialFields';
import { Field, Modal } from '../components/ui';
import { useAuth } from '../stores/authStore';
import { isHttpCredentialUrl, matchingProfiles } from '../lib/credentials';

export function AuthDialog({ challenge }: { challenge: AuthChallenge }) {
  return challenge.kind === 'https'
    ? <HttpAuthDialog challenge={challenge} />
    : <SshAuthDialog challenge={challenge} />;
}

function HttpAuthDialog({ challenge }: { challenge: AuthChallenge }) {
  const { t } = useTranslation();
  const form = useCredentialForm(challenge.url, challenge.username ?? '');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const submitting = useRef(false);
  const matches = matchingProfiles(challenge.url, challenge.profiles);
  const selected = matches.find((profile) => profile.id === form.choice);
  const valid = !!selected || (!!form.username.trim() && !!form.secret);

  const cancel = async () => {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    form.setSecret('');
    try {
      await api.auth.cancel(challenge.id);
      useAuth.getState().resolve(challenge.id);
    } catch {
      setFailed(true);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };
  const submit = async () => {
    if (submitting.current || !valid) return;
    submitting.current = true;
    setBusy(true);
    setFailed(false);
    try {
      await api.auth.respond({
        id: challenge.id,
        credentialId: selected?.id ?? null,
        username: selected?.username ?? form.username.trim(),
        secret: selected ? '' : form.secret,
        remember: !selected && form.remember,
        name: !selected && form.remember ? form.name.trim() || null : null,
      });
      form.setSecret('');
      useAuth.getState().resolve(challenge.id);
    } catch {
      // Do not put arbitrary backend messages (possibly containing credentials) in a store/toast.
      form.setSecret('');
      setFailed(true);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  return <Modal title={t('auth.title')} priority={100} onClose={() => void cancel()} width={540} footer={<>
    <button disabled={busy} onClick={() => void cancel()}>{t('auth.cancel')}</button>
    <button disabled={busy} onClick={() => useAuth.getState().defer()}>{t('auth.later')}</button>
    <button className="primary" disabled={busy || !valid} onClick={() => void submit()}>{t('auth.continue')}</button>
  </>}>
    <p>{t('auth.required')}</p>
    <p className="mono auth-url">{challenge.url}</p>
    {(challenge.error || failed) && <p className="error-text" role="alert">{t(failed ? 'auth.responseFailed' : challenge.error === 'credential.rejected' ? 'auth.rejected' : 'auth.profilesUnavailable')}</p>}
    <CredentialFields url={challenge.url} profiles={challenge.profiles} form={form} automatic={false} disabled={busy} />
    <p className="muted small-text">{t('auth.expires', { time: new Date(challenge.expiresAt).toLocaleTimeString() })}</p>
  </Modal>;
}

/** Only recognized OpenSSH fingerprints may be offered for explicit trust. */
function hasHostFingerprint(fingerprint: string | null | undefined) {
  return !!fingerprint && /^(?:SHA256:[A-Za-z0-9+/]{43}=?|MD5:(?:[a-fA-F0-9]{2}:){15}[a-fA-F0-9]{2})$/.test(fingerprint);
}

function SshAuthDialog({ challenge }: { challenge: AuthChallenge }) {
  const { t } = useTranslation();
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const submitting = useRef(false);
  const secretInput = useRef<HTMLInputElement>(null);
  const hostKey = challenge.kind === 'sshHostKey';
  const ssh = challenge.ssh;
  const valid = hostKey ? hasHostFingerprint(ssh?.fingerprint) : !!secret.trim();
  useEffect(() => {
    const input = secretInput.current;
    // Unmount also discards all component-local secret state, including on defer/expiry.
    return () => { if (input) input.value = ''; };
  }, []);

  const cancel = async () => {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setSecret('');
    try {
      await api.auth.cancel(challenge.id);
      useAuth.getState().resolve(challenge.id);
    } catch {
      setFailed(true);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };
  const submit = async () => {
    if (submitting.current || !valid) return;
    submitting.current = true;
    setBusy(true);
    setFailed(false);
    const reply = hostKey ? 'yes' : secret;
    setSecret('');
    try {
      await api.auth.respond({
        id: challenge.id,
        credentialId: null,
        username: hostKey ? '' : ssh?.username ?? challenge.username ?? '',
        secret: reply,
        remember: false,
        name: null,
      });
      useAuth.getState().resolve(challenge.id);
    } catch {
      // Never surface arbitrary backend text, prompts or secrets.
      setFailed(true);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  const details: [string, string | number | null | undefined][] = [
    ['destination', ssh?.destination ?? challenge.url],
    ['host', ssh?.host],
    ['port', ssh?.port],
    ['username', ssh?.username ?? challenge.username],
    ['keyPath', ssh?.keyPath],
    ['keyType', hostKey ? ssh?.keyType : null],
    ['fingerprint', hostKey ? ssh?.fingerprint : null],
  ];

  return <Modal title={t(hostKey ? 'auth.ssh.hostKeyTitle' : 'auth.title')} priority={100} onClose={() => void cancel()} width={540} footer={<>
    <button disabled={busy} onClick={() => void cancel()}>{t(hostKey ? 'auth.ssh.deny' : 'auth.cancel')}</button>
    <button disabled={busy} onClick={() => { setSecret(''); useAuth.getState().defer(); }}>{t('auth.later')}</button>
    {(!hostKey || valid) && <button className="primary" disabled={busy || !valid} onClick={() => void submit()}>{t(hostKey ? 'auth.ssh.trust' : 'auth.continue')}</button>}
  </>}>
    <p>{t(hostKey ? 'auth.ssh.hostKeyRequired' : challenge.kind === 'sshPassphrase' ? 'auth.ssh.passphraseRequired' : 'auth.ssh.passwordRequired')}</p>
    <dl>
      {details.map(([label, value]) => value !== null && value !== undefined && value !== '' && <div key={label}>
        <dt className="muted small-text">{t(`auth.ssh.${label}`)}</dt>
        <dd className="mono auth-url">{value}</dd>
      </div>)}
    </dl>
    {hostKey ? <>
      <p className="warn-text" role="note">{t('auth.ssh.hostKeyWarning')}</p>
      {!valid && <p className="error-text" role="alert">{t('auth.ssh.fingerprintMissing')}</p>}
    </> : <>
      <Field label={t(challenge.kind === 'sshPassphrase' ? 'auth.ssh.passphrase' : 'auth.ssh.password')}>
        <input ref={secretInput} type="password" autoComplete="new-password" spellCheck={false} disabled={busy} value={secret} onChange={(e) => setSecret(e.target.value)} />
      </Field>
      <p className="muted small-text">{t('auth.ssh.oneTime')}</p>
    </>}
    {(failed || challenge.error) && <p className="error-text" role="alert">{t(failed ? 'auth.responseFailed' : 'errors.ssh.unavailable')}</p>}
    <p className="muted small-text">{t('auth.expires', { time: new Date(challenge.expiresAt).toLocaleTimeString() })}</p>
  </Modal>;
}

/** Independent of App's Dialogs: multiple Git operations can queue nonsecret challenges. */
export function AuthHost() {
  const challenges = useAuth((s) => s.challenges);
  const activeId = useAuth((s) => s.activeId);
  useEffect(() => {
    const values = Object.values(challenges);
    if (!values.length) return;
    const expire = () => values.forEach((challenge) => {
      if (challenge.expiresAt <= Date.now()) useAuth.getState().resolve(challenge.id);
    });
    const next = Math.min(...values.map((challenge) => challenge.expiresAt));
    const timeout = window.setTimeout(expire, Math.max(0, Math.min(next - Date.now(), 2_147_483_647)));
    return () => window.clearTimeout(timeout);
  }, [challenges]);
  const challenge = activeId ? challenges[activeId] : null;
  const supported = challenge && (challenge.kind === 'https' ? isHttpCredentialUrl(challenge.url)
    : ['sshPassword', 'sshPassphrase', 'sshHostKey'].includes(challenge.kind));
  return supported ? <AuthDialog key={challenge.id} challenge={challenge} /> : null;
}
