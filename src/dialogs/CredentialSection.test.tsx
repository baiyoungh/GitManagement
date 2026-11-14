import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import i18n from '../i18n';
import { api } from '../api';
import { useApp } from '../stores/appStore';
import { CredentialSection } from './CredentialSection';
import { SettingsDialog } from './SettingsDialog';
const profile = { id: 'work', name: 'Work', url: 'https://example.com', username: 'alice' };
beforeEach(async () => { await i18n.changeLanguage('en-US'); vi.spyOn(api.credential, 'list').mockResolvedValue([profile]); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it('shows the profile manager in Settings without reading secrets', async () => {
  const get = vi.spyOn(api.credential, 'getUser');
  render(<SettingsDialog />);
  fireEvent.click(screen.getByRole('button', { name: 'Credentials' }));
  await screen.findByText('Work');
  expect(get).not.toHaveBeenCalled();
});
it('leaves the edit password blank and preserves it through a null secret', async () => {
  const upsert = vi.spyOn(api.credential, 'upsert').mockResolvedValue({ ...profile, name: 'Renamed' });
  render(<CredentialSection />);
  fireEvent.click(await screen.findByRole('button', { name: 'Edit Work' }));
  expect((screen.getByLabelText(/Token \/ password/) as HTMLInputElement).value).toBe('');
  fireEvent.change(screen.getByLabelText('Credential name'), { target: { value: 'Renamed' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(upsert).toHaveBeenCalledWith({ ...profile, name: 'Renamed', secret: null }));
  await screen.findByText('Renamed');
});
it('adds profiles and clears component-local secrets after save', async () => {
  const upsert = vi.spyOn(api.credential, 'upsert').mockResolvedValue({ id: 'new', name: 'Personal', url: 'https://git.test', username: 'bob' });
  render(<CredentialSection />);
  fireEvent.click(await screen.findByRole('button', { name: 'Add credential' }));
  fireEvent.change(screen.getByLabelText('Credential name'), { target: { value: 'Personal' } });
  fireEvent.change(screen.getByLabelText(/URL/), { target: { value: 'https://git.test' } });
  fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'bob' } });
  fireEvent.change(screen.getByLabelText('Token / password'), { target: { value: 'PRIVATE' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(upsert).toHaveBeenCalledWith({ id: null, name: 'Personal', url: 'https://git.test', username: 'bob', secret: 'PRIVATE' }));
  await waitFor(() => expect(screen.queryByLabelText('Token / password')).toBeNull());
  expect(JSON.stringify(useApp.getState())).not.toContain('PRIVATE');
});
it('deletes by id after confirmation', async () => {
  const remove = vi.spyOn(api.credential, 'remove').mockResolvedValue();
  vi.spyOn(useApp.getState(), 'ask').mockResolvedValue(true);
  render(<CredentialSection />);
  fireEvent.click(await screen.findByRole('button', { name: 'Delete Work' }));
  await waitFor(() => expect(remove).toHaveBeenCalledWith('work'));
  await waitFor(() => expect(screen.queryByText('Work')).toBeNull());
});
