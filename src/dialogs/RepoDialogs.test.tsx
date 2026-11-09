import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import '../i18n';
import { api } from '../api';
import { queryClient } from '../api/queries';
import { useApp } from '../stores/appStore';
import { AddRepoDialog } from './RepoDialogs';

afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.restoreAllMocks();
});

it('passes the optional display name when adding a repository', async () => {
  useApp.setState({ dialog: null });
  vi.spyOn(api.repo, 'checkPath').mockResolvedValue({ exists: true, isRepo: true, root: '/work/app', registered: false });
  const add = vi.spyOn(api.repo, 'add').mockResolvedValue({ id: 'x', name: 'Friendly', path: '/work/app' } as never);

  render(
    <QueryClientProvider client={queryClient}>
      <AddRepoDialog />
    </QueryClientProvider>,
  );

  fireEvent.change(screen.getByLabelText('目录'), { target: { value: '/work/app' } });
  const addButton = screen.getByRole('button', { name: '添加' }) as HTMLButtonElement;
  await waitFor(() => expect(addButton.disabled).toBe(false));

  // 留空时输入框提示现有模式给出的名称（仓库根目录的文件夹名）
  expect((screen.getByLabelText(/名称（可选）/) as HTMLInputElement).placeholder).toBe('app');

  fireEvent.change(screen.getByLabelText(/名称（可选）/), { target: { value: '  Friendly  ' } });
  fireEvent.click(addButton);
  await waitFor(() => expect(add).toHaveBeenCalledWith('/work/app', false, '  Friendly  '));
});
