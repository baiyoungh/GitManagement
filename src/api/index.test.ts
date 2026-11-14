import { afterEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { api } from './index';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue(undefined), Channel: class {} }));
afterEach(() => vi.clearAllMocks());
it('uses the agreed profile command names and argument wrappers', async () => {
  const input = { id: 'a', name: 'Work', url: 'https://example.com', username: 'alice', secret: null };
  await api.credential.list();
  await api.credential.upsert(input);
  await api.credential.remove('a');
  expect(invoke).toHaveBeenNthCalledWith(1, 'credential_list', undefined);
  expect(invoke).toHaveBeenNthCalledWith(2, 'credential_upsert', { input });
  expect(invoke).toHaveBeenNthCalledWith(3, 'credential_remove', { id: 'a' });
});
it('uses SSH key commands without storing the passphrase in settings', async () => {
  const input = { name: 'id_ed25519', comment: 'test', passphrase: 'local-only' };
  await api.sshKeys.directory();
  await api.sshKeys.list();
  await api.sshKeys.generate(input);
  await api.sshKeys.readPublic('/tmp/key.pub');
  expect(invoke).toHaveBeenNthCalledWith(1, 'ssh_keys_directory', undefined);
  expect(invoke).toHaveBeenNthCalledWith(2, 'ssh_keys_list', undefined);
  expect(invoke).toHaveBeenNthCalledWith(3, 'ssh_keys_generate', { input });
  expect(invoke).toHaveBeenNthCalledWith(4, 'ssh_keys_read_public', { path: '/tmp/key.pub' });
});

it('uses flat auth response args and silent auto fetch flag', async () => {
  const response = { id: 'a', credentialId: null, username: 'alice', secret: 'one-time', remember: false };
  await api.auth.pending();
  await api.auth.respond(response);
  await api.auth.cancel('a');
  await api.task.fetchAll();
  await api.task.fetchAll(true);
  expect(invoke).toHaveBeenNthCalledWith(1, 'auth_pending', undefined);
  expect(invoke).toHaveBeenNthCalledWith(2, 'auth_respond', response);
  expect(invoke).toHaveBeenNthCalledWith(3, 'auth_cancel', { id: 'a' });
  expect(invoke).toHaveBeenNthCalledWith(4, 'task_fetch_all', { silent: false });
  expect(invoke).toHaveBeenNthCalledWith(5, 'task_fetch_all', { silent: true });
});
