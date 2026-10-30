import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import '../i18n';
import { api } from '../api';
import { queryClient } from '../api/queries';
import { useApp } from '../stores/appStore';
import { Sidebar } from './Sidebar';
import { PromptHost } from './ui';

beforeEach(() => {
  queryClient.clear();
  useApp.setState({ selectedRepoId: 'root', multiSelected: [], dialog: null, promptReq: null });
  vi.spyOn(api.repo, 'list').mockResolvedValue([
    { id: 'root', name: 'Project Alias', path: '/workspace/actual-folder', groupId: null, missing: false },
    { id: 'child', name: 'Child Alias', path: '/workspace/actual-folder/services/child', groupId: null, missing: false },
  ] as never);
  vi.spyOn(api.group, 'list').mockResolvedValue([]);
  vi.spyOn(api.repo, 'summary').mockResolvedValue({ branch: 'main', ahead: 0, behind: 0 } as never);
  vi.spyOn(api.repo, 'rename').mockResolvedValue();
});
afterEach(() => { cleanup(); queryClient.clear(); vi.restoreAllMocks(); });

function show() { render(<QueryClientProvider client={queryClient}><Sidebar /><PromptHost /></QueryClientProvider>); }

it('shows aliases above actual folders and identifies nested repositories', async () => {
  show();
  await screen.findByText('Project Alias');
  expect(screen.getByText('actual-folder').closest('.repo-meta')).toBeTruthy();
  expect(screen.getByLabelText('子仓库，位于 Project Alias 内')).toBeTruthy();
  expect(screen.getByText('Child Alias').closest('button')?.title).toBe('/workspace/actual-folder/services/child');
});

it('renames only the display name and preserves the actual path', async () => {
  show();
  fireEvent.click(await screen.findByRole('button', { name: '重命名 Project Alias' }));
  const name = screen.getByRole('textbox', { name: '显示名称' });
  fireEvent.change(name, { target: { value: '   ' } });
  expect((screen.getByRole('button', { name: '确定' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(name, { target: { value: '  New Alias  ' } });
  fireEvent.submit(name.closest('form')!);
  await waitFor(() => expect(api.repo.rename).toHaveBeenCalledWith('root', 'New Alias'));
  expect(screen.getByText('actual-folder')).toBeTruthy();
  expect(api.repo.list).toHaveBeenCalledTimes(2);
});

it('opens nested scanning at the repository root and supports F2 rename', async () => {
  show();
  const row = (await screen.findByText('Project Alias')).closest('button')!;
  fireEvent.contextMenu(row);
  fireEvent.click(screen.getByRole('menuitem', { name: '扫描子仓库…' }));
  expect(useApp.getState().dialog).toEqual({ type: 'scan', root: '/workspace/actual-folder', groupId: null });
  fireEvent.keyDown(row, { key: 'F2' });
  expect(screen.getByRole('textbox', { name: '显示名称' })).toBeTruthy();
});
