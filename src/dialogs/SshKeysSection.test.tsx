import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '../i18n';
import { api } from '../api';
import type { SshKeyInfo } from '../api/types';
import { SshKeysSection } from './SshKeysSection';

const key: SshKeyInfo = { name: 'id_ed25519', publicPath: '/home/test/.ssh/id_ed25519.pub', privatePath: '/home/test/.ssh/id_ed25519', publicKey: 'ssh-ed25519 AAAATEST public-comment', fingerprint: 'SHA256:test', keyType: 'ssh-ed25519', comment: 'public-comment' };
beforeEach(() => {
  vi.spyOn(api.sshKeys, 'list').mockResolvedValue([]);
  vi.spyOn(api.sshKeys, 'directory').mockResolvedValue('/home/test/.ssh');
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('generates only after matching passphrases and clears secrets while waiting', async () => {
  let finish!: (value: SshKeyInfo) => void;
  const generate = vi.spyOn(api.sshKeys, 'generate').mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  render(<SshKeysSection />);
  const start = await screen.findByRole('button', { name: '生成 SSH 密钥' });
  await waitFor(() => expect((start as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(start);
  const submit = screen.getByRole('button', { name: '生成密钥对' }) as HTMLButtonElement;
  expect(submit.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('私钥口令'), { target: { value: 'test-private-phrase' } });
  fireEvent.change(screen.getByLabelText('确认口令'), { target: { value: 'wrong' } });
  expect(submit.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('确认口令'), { target: { value: 'test-private-phrase' } });
  fireEvent.click(submit);
  fireEvent.click(submit);
  expect(generate).toHaveBeenCalledTimes(1);
  expect(generate).toHaveBeenCalledWith({ name: 'id_ed25519', comment: 'GitManagement', passphrase: 'test-private-phrase' });
  expect((screen.getByLabelText('私钥口令') as HTMLInputElement).value).toBe('');
  finish(key);
  await screen.findByDisplayValue(key.publicKey);
  expect(screen.queryByLabelText('私钥口令')).toBeNull();
  expect(document.body.textContent).not.toContain('test-private-phrase');
});

it('requires an explicit no-passphrase choice and disallows existing filenames', async () => {
  vi.mocked(api.sshKeys.list).mockResolvedValue([key]);
  const generate = vi.spyOn(api.sshKeys, 'generate').mockResolvedValue({ ...key, name: 'other' });
  render(<SshKeysSection />);
  await screen.findByText(key.fingerprint);
  fireEvent.click(screen.getByRole('button', { name: '生成 SSH 密钥' }));
  fireEvent.click(screen.getByLabelText('不设置口令（不推荐）'));
  const submit = screen.getByRole('button', { name: '生成密钥对' }) as HTMLButtonElement;
  expect(submit.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('密钥文件名'), { target: { value: '../overwrite' } });
  expect(submit.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('密钥文件名'), { target: { value: 'other' } });
  fireEvent.click(submit);
  await waitFor(() => expect(generate).toHaveBeenCalledWith({ name: 'other', comment: 'GitManagement', passphrase: '' }));
});

it('copies only the public key and provides configuration without writing it', async () => {
  vi.mocked(api.sshKeys.list).mockResolvedValue([key]);
  const write = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: write } });
  render(<SshKeysSection />);
  fireEvent.click(await screen.findByRole('button', { name: '复制 id_ed25519 的公钥' }));
  expect(write).toHaveBeenCalledWith(key.publicKey);
  fireEvent.click(screen.getByRole('button', { name: '查看 id_ed25519 的公钥' }));
  fireEvent.click(screen.getByRole('button', { name: '查看 SSH 配置示例' }));
  expect(screen.getByText(/IdentityFile/, { selector: 'pre' }).textContent).toContain(key.privatePath);
  expect(screen.getByDisplayValue(key.publicKey)).toHaveProperty('readOnly', true);
});

it('shows sanitized generation errors and never reflects arbitrary details', async () => {
  vi.spyOn(api.sshKeys, 'generate').mockRejectedValue({ code: 'internal', detail: 'private-secret' });
  render(<SshKeysSection />);
  const start = screen.getByRole('button', { name: '生成 SSH 密钥' });
  await waitFor(() => expect((start as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(start);
  fireEvent.click(screen.getByLabelText('不设置口令（不推荐）'));
  fireEvent.click(screen.getByRole('button', { name: '生成密钥对' }));
  await screen.findByRole('alert');
  expect(document.body.textContent).not.toContain('private-secret');
});
