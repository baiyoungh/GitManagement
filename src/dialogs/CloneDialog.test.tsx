import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import i18n from '../i18n';
import { api } from '../api';
import { useApp } from '../stores/appStore';
import { useAuth } from '../stores/authStore';
import { CloneDialog } from './RepoDialogs';
const profiles = [
  { id: 'work', name: 'Work', url: 'https://EXAMPLE.com:443', username: 'alice' },
  { id: 'wrong', name: 'Wrong', url: 'https://other.com', username: 'bob' },
];
beforeEach(async () => {
  await i18n.changeLanguage('en-US');
  useApp.setState({ settings: { cloneParent: '/work' }, dialog: null });
  useAuth.setState({ cloneRetries: {} });
  vi.spyOn(api.credential, 'list').mockResolvedValue(profiles);
  vi.spyOn(api.settings, 'set').mockResolvedValue();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function setup(url = 'https://example.com/repo.git') {
  render(<CloneDialog />);
  fireEvent.change(screen.getByLabelText(/Repository URL/), { target: { value: url } });
}
it('defaults HTTPS to automatic authentication and submits no credentials', async () => {
  const clone = vi.spyOn(api.task, 'clone').mockResolvedValue('task');
  setup();
  expect((screen.getByLabelText('Account') as HTMLSelectElement).value).toBe('auto');
  fireEvent.click(screen.getByRole('button', { name: 'Clone' }));
  await waitFor(() => expect(clone).toHaveBeenCalledWith({ url: 'https://example.com/repo.git', dest: '/work/repo', branch: null, depth: null, name: '' }));
});
it('offers only normalized matching profiles and submits an id', async () => {
  const clone = vi.spyOn(api.task, 'clone').mockResolvedValue('task');
  setup();
  await screen.findByRole('option', { name: /Work/ });
  expect(screen.queryByRole('option', { name: /Wrong/ })).toBeNull();
  fireEvent.change(screen.getByLabelText('Account'), { target: { value: 'work' } });
  fireEvent.click(screen.getByRole('button', { name: 'Clone' }));
  await waitFor(() => expect(clone.mock.calls[0][0].credentialId).toBe('work'));
  expect(clone.mock.calls[0][0].credential).toBeUndefined();
});
it('keeps inline credentials one-time by default, supports remembering, and blocks duplicate submissions', async () => {
  let finish!: (id: string) => void;
  const clone = vi.spyOn(api.task, 'clone').mockImplementation(() => new Promise<string>((resolve) => { finish = resolve; }));
  setup();
  fireEvent.change(screen.getByLabelText('Account'), { target: { value: 'other' } });
  expect((screen.getByLabelText('Remember in the system keychain') as HTMLInputElement).checked).toBe(false);
  fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'alice' } });
  fireEvent.change(screen.getByLabelText('Token / password'), { target: { value: 'PRIVATE' } });
  fireEvent.click(screen.getByLabelText('Remember in the system keychain'));
  fireEvent.change(screen.getByLabelText('Credential name'), { target: { value: 'Work account' } });
  fireEvent.click(screen.getByRole('button', { name: 'Clone' }));
  fireEvent.click(screen.getByRole('button', { name: 'Clone' }));
  expect(clone).toHaveBeenCalledTimes(1);
  expect(clone.mock.calls[0][0].credential).toEqual({ username: 'alice', secret: 'PRIVATE', remember: true, name: 'Work account' });
  finish('task');
  await waitFor(() => expect(useAuth.getState().cloneRetries.task).toBeDefined());
  expect(JSON.stringify(useAuth.getState())).not.toContain('PRIVATE');
  expect(JSON.stringify(useApp.getState())).not.toContain('PRIVATE');
});
it('submits inline credentials without remembering by default', async () => {
  const clone = vi.spyOn(api.task, 'clone').mockResolvedValue('task');
  setup();
  await screen.findByRole('option', { name: /Work/ });
  fireEvent.change(screen.getByLabelText('Account'), { target: { value: 'other' } });
  fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'alice' } });
  fireEvent.change(screen.getByLabelText('Token / password'), { target: { value: 'PRIVATE' } });
  fireEvent.click(screen.getByRole('button', { name: 'Clone' }));
  await waitFor(() => expect(clone).toHaveBeenCalled());
  expect(clone.mock.calls[0][0].credential?.remember).toBe(false);
});
it('clears a rejected secret without leaking backend errors to stores', async () => {
  vi.spyOn(api.task, 'clone').mockRejectedValue(new Error('sensitive PRIVATE'));
  setup();
  await screen.findByRole('option', { name: /Work/ });
  fireEvent.change(screen.getByLabelText('Account'), { target: { value: 'other' } });
  fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'alice' } });
  fireEvent.change(screen.getByLabelText('Token / password'), { target: { value: 'PRIVATE' } });
  fireEvent.click(screen.getByRole('button', { name: 'Clone' }));
  await screen.findByRole('alert');
  expect((screen.getByLabelText('Token / password') as HTMLInputElement).value).toBe('');
  expect(JSON.stringify(useApp.getState())).not.toContain('PRIVATE');
});
it('clears profile selection and secret when target origin changes, not repository paths', async () => {
  setup();
  await screen.findByRole('option', { name: /Work/ });
  fireEvent.change(screen.getByLabelText('Account'), { target: { value: 'other' } });
  fireEvent.change(screen.getByLabelText('Token / password'), { target: { value: 'PRIVATE' } });
  fireEvent.change(screen.getByLabelText(/Repository URL/), { target: { value: 'https://example.com/another.git' } });
  expect((screen.getByLabelText('Token / password') as HTMLInputElement).value).toBe('PRIVATE');
  fireEvent.change(screen.getByLabelText(/Repository URL/), { target: { value: 'https://other.com/repo.git' } });
  expect((screen.getByLabelText('Account') as HTMLSelectElement).value).toBe('auto');
  fireEvent.change(screen.getByLabelText('Account'), { target: { value: 'other' } });
  expect((screen.getByLabelText('Token / password') as HTMLInputElement).value).toBe('');
});
it.each(['git@example.com:repo.git', 'ssh://git@example.com/repo.git'])('does not offer HTTPS credentials for %s', async (url) => {
  setup(url);
  await waitFor(() => expect(api.credential.list).toHaveBeenCalled());
  expect(screen.queryByLabelText('Account')).toBeNull();
  expect(screen.getByText(url.startsWith('http:') ? /HTTP is unencrypted/ : /SSH uses your existing/)).toBeDefined();
});
it('offers HTTP credentials with an explicit unencrypted warning', async () => {
  const clone = vi.spyOn(api.task, 'clone').mockResolvedValue('task');
  setup('http://example.com/repo.git');
  await waitFor(() => expect(api.credential.list).toHaveBeenCalled());
  expect(screen.getByText(/HTTP is unencrypted/)).toBeDefined();
  fireEvent.change(screen.getByLabelText('Account'), { target: { value: 'other' } });
  fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'alice' } });
  fireEvent.change(screen.getByLabelText('Token / password'), { target: { value: 'secret' } });
  fireEvent.click(screen.getByRole('button', { name: 'Clone' }));
  await waitFor(() => expect(clone).toHaveBeenCalled());
  expect(clone.mock.calls[0][0].credential?.remember).toBe(false);
});
it('prefills an explicit retry without remembering any credentials', async () => {
  render(<CloneDialog initial={{ url: 'https://example.com/repo.git', dest: '/work/custom', branch: 'main', depth: 10, name: 'Repo' }} />);
  await screen.findByRole('option', { name: /Work/ });
  expect((screen.getByLabelText(/Directory name/) as HTMLInputElement).value).toBe('custom');
  expect((screen.getByLabelText('Account') as HTMLSelectElement).value).toBe('auto');
});
