import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import i18n from '../i18n';
import { api } from '../api';
import type { AuthChallenge } from '../api/types';
import { useAuth } from '../stores/authStore';
import { AuthHost } from './AuthDialog';
const challenge = (): AuthChallenge => ({ id: 'one', taskId: 'task', url: 'https://example.com/repo', kind: 'https', username: 'alice', error: null, expiresAt: Date.now() + 60_000, profiles: [
  { id: 'work', name: 'Work', url: 'https://EXAMPLE.com:443', username: 'alice' },
  { id: 'wrong', name: 'Wrong', url: 'https://other.com', username: 'bob' },
] });
beforeEach(async () => { await i18n.changeLanguage('en-US'); useAuth.setState({ challenges: {}, resolved: {}, activeId: null }); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function show() { useAuth.getState().upsert(challenge()); render(<AuthHost />); }
function sshChallenge(kind: AuthChallenge['kind'] = 'sshPassword', id = 'ssh'): AuthChallenge {
  return {
    ...challenge(), id, kind, url: 'git@alias:team/repo.git',
    ssh: {
      host: 'git.example.com', port: 2222, username: 'git', keyPath: '/home/alice/.ssh/work',
      fingerprint: `SHA256:${'A'.repeat(43)}`, keyType: 'ED25519', destination: 'git@alias:team/repo.git',
    },
  };
}

it.each([
  ['sshPassword', 'SSH password'], ['sshPassphrase', 'Private-key passphrase'],
] as const)('renders %s metadata, rejects blank input and sends only a one-time response', async (kind, label) => {
  let finish!: () => void;
  const respond = vi.spyOn(api.auth, 'respond').mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
  useAuth.getState().upsert(sshChallenge(kind));
  render(<AuthHost />);
  for (const value of ['git.example.com', '2222', 'git', '/home/alice/.ssh/work', 'git@alias:team/repo.git']) {
    expect(screen.getByText(value, { exact: true })).toBeDefined();
  }
  expect(screen.queryByRole('combobox')).toBeNull();
  expect(screen.queryByRole('checkbox')).toBeNull();
  expect(screen.queryByLabelText('Token / password')).toBeNull();
  expect(screen.queryByText('Work — alice')).toBeNull();
  const input = screen.getByLabelText(label) as HTMLInputElement;
  expect(input.type).toBe('password');
  const submit = screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement;
  expect(submit.disabled).toBe(true);
  fireEvent.change(input, { target: { value: '   ' } });
  expect(submit.disabled).toBe(true);
  fireEvent.click(submit);
  expect(respond).not.toHaveBeenCalled();
  fireEvent.change(input, { target: { value: ' PRIVATE ' } });
  expect(JSON.stringify(useAuth.getState())).not.toContain('PRIVATE');
  fireEvent.click(submit);
  fireEvent.click(submit);
  expect(input.value).toBe('');
  expect(respond).toHaveBeenCalledTimes(1);
  expect(respond).toHaveBeenCalledWith({
    id: 'ssh', username: 'git', secret: ' PRIVATE ', remember: false, credentialId: null, name: null,
  });
  finish();
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});

it('supports optional SSH metadata and falls back to the challenge username and destination', async () => {
  const respond = vi.spyOn(api.auth, 'respond').mockResolvedValue();
  useAuth.getState().upsert({ ...sshChallenge('sshPassphrase'), ssh: undefined });
  render(<AuthHost />);
  expect(screen.getByText('git@alias:team/repo.git')).toBeDefined();
  expect(screen.getByText('alice', { exact: true })).toBeDefined();
  fireEvent.change(screen.getByLabelText('Private-key passphrase'), { target: { value: 'PRIVATE' } });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await waitFor(() => expect(respond).toHaveBeenCalledWith({
    id: 'ssh', username: 'alice', secret: 'PRIVATE', remember: false, credentialId: null, name: null,
  }));
});

it('clears an SSH secret on a failed response without displaying backend text', async () => {
  vi.spyOn(api.auth, 'respond').mockRejectedValue(new Error('RAW_PRIVATE_PROMPT'));
  useAuth.getState().upsert(sshChallenge());
  render(<AuthHost />);
  fireEvent.change(screen.getByLabelText('SSH password'), { target: { value: 'PRIVATE' } });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  expect((await screen.findByRole('alert')).textContent).toContain('Unable to send the response');
  expect((screen.getByLabelText('SSH password') as HTMLInputElement).value).toBe('');
  expect(screen.queryByText('RAW_PRIVATE_PROMPT')).toBeNull();
  expect(JSON.stringify(useAuth.getState())).not.toContain('PRIVATE');
});

it.each(['Cancel operation', 'Escape', 'close'])('cancels the SSH operation via %s and clears the input before cancellation completes', async (action) => {
  let finish!: () => void;
  const cancel = vi.spyOn(api.auth, 'cancel').mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
  const respond = vi.spyOn(api.auth, 'respond').mockResolvedValue();
  useAuth.getState().upsert(sshChallenge());
  render(<AuthHost />);
  const input = screen.getByLabelText('SSH password') as HTMLInputElement;
  fireEvent.change(input, { target: { value: 'PRIVATE' } });
  if (action === 'Escape') fireEvent.keyDown(window, { key: 'Escape' });
  else fireEvent.click(screen.getByRole('button', { name: action }));
  expect(input.value).toBe('');
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(cancel).toHaveBeenCalledWith('ssh');
  expect(respond).not.toHaveBeenCalled();
  finish();
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});

it('discards the local SSH secret on defer and unmount', async () => {
  const cancel = vi.spyOn(api.auth, 'cancel').mockResolvedValue();
  useAuth.getState().upsert(sshChallenge('sshPassphrase'));
  const view = render(<AuthHost />);
  const input = screen.getByLabelText('Private-key passphrase') as HTMLInputElement;
  fireEvent.change(input, { target: { value: 'PRIVATE' } });
  fireEvent.click(screen.getByRole('button', { name: 'Later' }));
  expect(input.value).toBe('');
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(cancel).not.toHaveBeenCalled();
  act(() => useAuth.getState().open('ssh'));
  const reopened = await screen.findByLabelText('Private-key passphrase') as HTMLInputElement;
  expect(reopened.value).toBe('');
  fireEvent.change(reopened, { target: { value: 'PRIVATE' } });
  view.unmount();
  expect(reopened.value).toBe('');
  expect(JSON.stringify(useAuth.getState())).not.toContain('PRIVATE');
  render(<AuthHost />);
  expect((screen.getByLabelText('Private-key passphrase') as HTMLInputElement).value).toBe('');
});

it.each([`SHA256:${'A'.repeat(43)}`, `MD5:${Array(16).fill('ab').join(':')}`])('requires explicit trust for a host key with fingerprint %s', async (fingerprint) => {
  const respond = vi.spyOn(api.auth, 'respond').mockResolvedValue();
  const item = sshChallenge('sshHostKey');
  item.ssh!.fingerprint = fingerprint;
  useAuth.getState().upsert(item);
  render(<AuthHost />);
  expect(screen.getByRole('dialog', { name: 'Verify SSH host key' })).toBeDefined();
  expect(screen.getByText(fingerprint, { exact: true })).toBeDefined();
  expect(screen.getByText('ED25519', { exact: true })).toBeDefined();
  expect(screen.getByText('git@alias:team/repo.git', { exact: true })).toBeDefined();
  expect(screen.getByRole('note').textContent).toContain('out-of-band');
  expect(screen.getByRole('note').textContent).toContain('known_hosts');
  expect(screen.queryByRole('combobox')).toBeNull();
  expect(screen.queryByRole('checkbox')).toBeNull();
  expect(document.querySelector('input')).toBeNull();
  expect(respond).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Trust host key and continue' }));
  await waitFor(() => expect(respond).toHaveBeenCalledWith({
    id: 'ssh', username: '', secret: 'yes', remember: false, credentialId: null, name: null,
  }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});

it('denies host-key trust by cancelling rather than replying to OpenSSH', async () => {
  const cancel = vi.spyOn(api.auth, 'cancel').mockResolvedValue();
  const respond = vi.spyOn(api.auth, 'respond').mockResolvedValue();
  useAuth.getState().upsert(sshChallenge('sshHostKey'));
  render(<AuthHost />);
  fireEvent.click(screen.getByRole('button', { name: 'Deny and cancel operation' }));
  await waitFor(() => expect(cancel).toHaveBeenCalledWith('ssh'));
  expect(respond).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});

it.each([null, '', ' ', 'SHA256:invalid', 'yes', 'MD5:ab:cd'])('offers no trust action for a missing or invalid fingerprint %s', (fingerprint) => {
  const respond = vi.spyOn(api.auth, 'respond').mockResolvedValue();
  const item = sshChallenge('sshHostKey');
  item.ssh!.fingerprint = fingerprint;
  useAuth.getState().upsert(item);
  render(<AuthHost />);
  expect(screen.getByRole('alert').textContent).toContain('valid host-key fingerprint is unavailable');
  expect(screen.queryByRole('button', { name: 'Trust host key and continue' })).toBeNull();
  expect(document.querySelector('input')).toBeNull();
  expect(respond).not.toHaveBeenCalled();
});

it('does not allow host-key trust when SSH metadata is absent', () => {
  useAuth.getState().upsert({ ...sshChallenge('sshHostKey'), ssh: undefined });
  render(<AuthHost />);
  expect(screen.getByRole('alert')).toBeDefined();
  expect(screen.queryByRole('button', { name: 'Trust host key and continue' })).toBeNull();
});

it('queues SSH and HTTP challenges without an HTTP URL gate for SSH', async () => {
  const respond = vi.spyOn(api.auth, 'respond').mockResolvedValue();
  const cancel = vi.spyOn(api.auth, 'cancel').mockResolvedValue();
  useAuth.getState().upsert(sshChallenge());
  useAuth.getState().upsert(challenge());
  useAuth.getState().upsert(sshChallenge('sshHostKey', 'host-key'));
  render(<AuthHost />);
  expect(screen.getByLabelText('SSH password')).toBeDefined();
  expect(screen.queryByLabelText('Account')).toBeNull();
  fireEvent.change(screen.getByLabelText('SSH password'), { target: { value: 'PRIVATE' } });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await screen.findByLabelText('Account');
  fireEvent.change(screen.getByLabelText('Account'), { target: { value: 'work' } });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await screen.findByRole('dialog', { name: 'Verify SSH host key' });
  expect(respond).toHaveBeenNthCalledWith(2, { id: 'one', credentialId: 'work', username: 'alice', secret: '', remember: false, name: null });
  fireEvent.click(screen.getByRole('button', { name: 'Deny and cancel operation' }));
  await waitFor(() => expect(cancel).toHaveBeenCalledWith('host-key'));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});

it('expires an SSH prompt, clears its secret and advances the queue without submitting', () => {
  vi.useFakeTimers();
  try {
    const respond = vi.spyOn(api.auth, 'respond').mockResolvedValue();
    const cancel = vi.spyOn(api.auth, 'cancel').mockResolvedValue();
    useAuth.getState().upsert({ ...sshChallenge(), expiresAt: Date.now() + 1_000 });
    useAuth.getState().upsert(challenge());
    render(<AuthHost />);
    const input = screen.getByLabelText('SSH password') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'PRIVATE' } });
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(input.value).toBe('');
    expect(screen.queryByLabelText('SSH password')).toBeNull();
    expect(screen.getByLabelText('Account')).toBeDefined();
    expect(useAuth.getState().challenges.ssh).toBeUndefined();
    expect(respond).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    expect(JSON.stringify(useAuth.getState())).not.toContain('PRIVATE');
  } finally {
    vi.useRealTimers();
  }
});

it('preserves the HTTP URL gate for HTTP challenges', () => {
  useAuth.getState().upsert({ ...challenge(), url: 'git@alias:team/repo.git' });
  render(<AuthHost />);
  expect(screen.queryByRole('dialog')).toBeNull();
});

it.each(['en-US', 'zh-CN'])('provides SSH errors and operation-only guidance in %s', async (language) => {
  await i18n.changeLanguage(language);
  for (const code of ['hostKeyChanged', 'hostKeyFailed', 'unsupportedPrompt', 'customCommand', 'notFound', 'invalidReply', 'unavailable']) {
    expect(i18n.exists(`errors.ssh.${code}`)).toBe(true);
    expect(i18n.t(`errors.ssh.${code}`)).not.toBe(`errors.ssh.${code}`);
  }
  expect(i18n.t('auth.sshNote')).toContain('OpenSSH');
  expect(i18n.t('auth.sshNote')).not.toContain('not supported');
  useAuth.getState().upsert(sshChallenge('sshHostKey'));
  render(<AuthHost />);
  expect(screen.getByRole('button', { name: i18n.t('auth.ssh.trust') })).toBeDefined();
  expect(screen.getByRole('note').textContent).not.toContain('auth.ssh');
});

it('opens HTTP challenges with a visible unencrypted warning', () => {
  useAuth.getState().upsert({ ...challenge(), url: 'http://example.com/repo' });
  render(<AuthHost />);
  expect(screen.getByRole('dialog')).toBeDefined();
  expect(screen.getByText(/HTTP is unencrypted/)).toBeDefined();
});
it('submits a matching saved profile without retrieving its secret', async () => {
  const respond = vi.spyOn(api.auth, 'respond').mockResolvedValue();
  show();
  expect(screen.queryByRole('option', { name: /Wrong/ })).toBeNull();
  fireEvent.change(screen.getByLabelText('Account'), { target: { value: 'work' } });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await waitFor(() => expect(respond).toHaveBeenCalledWith({ id: 'one', credentialId: 'work', username: 'alice', secret: '', remember: false, name: null }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});
it('keeps a one-time secret component-local and prevents duplicate response', async () => {
  let finish!: () => void;
  const respond = vi.spyOn(api.auth, 'respond').mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
  show();
  fireEvent.change(screen.getByLabelText('Token / password'), { target: { value: 'PRIVATE' } });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  expect(respond).toHaveBeenCalledTimes(1);
  expect(respond.mock.calls[0][0].remember).toBe(false);
  expect(JSON.stringify(useAuth.getState())).not.toContain('PRIVATE');
  finish();
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});
it('clears secrets on failed response, shows safe guidance and accepts explicit remember', async () => {
  const respond = vi.spyOn(api.auth, 'respond').mockRejectedValue(new Error('PRIVATE'));
  show();
  fireEvent.change(screen.getByLabelText('Token / password'), { target: { value: 'PRIVATE' } });
  fireEvent.click(screen.getByLabelText('Remember in the system keychain'));
  fireEvent.change(screen.getByLabelText('Credential name'), { target: { value: 'Work' } });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await screen.findByRole('alert');
  expect(respond.mock.calls[0][0]).toMatchObject({ remember: true, name: 'Work' });
  expect((screen.getByLabelText('Token / password') as HTMLInputElement).value).toBe('');
  expect(JSON.stringify(useAuth.getState())).not.toContain('PRIVATE');
});
it('cancels the operation on Escape and leaves other dialogs independent', async () => {
  const cancel = vi.spyOn(api.auth, 'cancel').mockResolvedValue();
  show();
  fireEvent.keyDown(window, { key: 'Escape' });
  await waitFor(() => expect(cancel).toHaveBeenCalledWith('one'));
  await waitFor(() => expect(useAuth.getState().challenges).toEqual({}));
});
it('defers without cancelling and clears password on reopen', async () => {
  const cancel = vi.spyOn(api.auth, 'cancel').mockResolvedValue();
  show();
  fireEvent.change(screen.getByLabelText('Token / password'), { target: { value: 'PRIVATE' } });
  fireEvent.click(screen.getByRole('button', { name: 'Later' }));
  expect(cancel).not.toHaveBeenCalled();
  expect(screen.queryByRole('dialog')).toBeNull();
  act(() => useAuth.getState().open('one'));
  await waitFor(() => expect((screen.getByLabelText('Token / password') as HTMLInputElement).value).toBe(''));
});
