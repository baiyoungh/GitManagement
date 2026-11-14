import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import '../i18n';
import { api } from '../api';
import { queryClient } from '../api/queries';
import { useApp } from '../stores/appStore';
import { fileKey, useFiles } from '../stores/fileStore';
import { FilesView } from './FilesView';
import { ConfirmHost, PromptHost } from '../components/ui';

vi.mock('../components/CodeEditor', () => ({ CodeEditor: ({ text }: { text: string }) => <pre>{text}</pre>, forgetEditor: vi.fn() }));
const source = { text: 'disk', revision: 'v1', size: 4, eol: 'LF', bom: false, readOnly: null };
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  queryClient.clear();
  useFiles.setState({ buffers: {}, selected: {} });
  useApp.setState({ confirm: null, promptReq: null, toasts: [] });
  vi.spyOn(api.files, 'list').mockImplementation(async (_repo, path) => ({ entries: path ? [] : [
    { name: 'src', path: 'src', directory: true, symlink: false },
    { name: 'a.txt', path: 'a.txt', directory: false, symlink: false },
  ], truncated: false }));
  vi.spyOn(api.files, 'read').mockResolvedValue(source);
  vi.spyOn(api.files, 'create').mockResolvedValue();
  vi.spyOn(api.files, 'rename').mockResolvedValue();
  vi.spyOn(api.files, 'delete').mockResolvedValue();
});
afterEach(() => { cleanup(); queryClient.clear(); vi.restoreAllMocks(); });
function show() { render(<QueryClientProvider client={queryClient}><FilesView repoId="r" /><ConfirmHost /><PromptHost /></QueryClientProvider>); }
async function nameAndSubmit(name: string) {
  const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value: name } });
  await act(async () => { fireEvent.submit(input.closest('form')!); });
}

it('creates files in the selected directory, validates names, and opens the new file', async () => {
  show();
  fireEvent.click(await screen.findByRole('treeitem', { name: 'src' }));
  fireEvent.click(screen.getByRole('button', { name: '新建文件' }));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '../escape' } });
  expect((screen.getByRole('button', { name: '确定' }) as HTMLButtonElement).disabled).toBe(true);
  await nameAndSubmit('new.txt');
  await waitFor(() => expect(api.files.create).toHaveBeenCalledWith('r', 'src/new.txt', false));
  await waitFor(() => expect(useFiles.getState().selected.r).toBe('src/new.txt'));
});

it('renames an open file and preserves unsaved edits', async () => {
  show();
  fireEvent.click(await screen.findByRole('treeitem', { name: 'a.txt' }));
  await waitFor(() => expect(useFiles.getState().buffers[fileKey('r', 'a.txt')]).toBeTruthy());
  act(() => useFiles.getState().edit(fileKey('r', 'a.txt'), 'unsaved'));
  fireEvent.click(screen.getByRole('button', { name: '重命名' }));
  await nameAndSubmit('b.txt');
  await waitFor(() => expect(useFiles.getState().selected.r).toBe('b.txt'));
  expect(api.files.rename).toHaveBeenCalledWith('r', 'a.txt', 'b.txt');
  await waitFor(() => expect(useFiles.getState().buffers[fileKey('r', 'b.txt')]?.text).toBe('unsaved'));
  await screen.findByText('unsaved');
});

it('requires confirmation and warns before deleting unsaved edits', async () => {
  show();
  fireEvent.click(await screen.findByRole('treeitem', { name: 'a.txt' }));
  await waitFor(() => expect(useFiles.getState().buffers[fileKey('r', 'a.txt')]).toBeTruthy());
  act(() => useFiles.getState().edit(fileKey('r', 'a.txt'), 'unsaved'));
  fireEvent.click(screen.getByRole('button', { name: '删除' }));
  expect(screen.getByText(/此文件还有未保存修改/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  expect(api.files.delete).not.toHaveBeenCalled();
  await waitFor(() => expect((screen.getByRole('button', { name: '删除' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: '删除' }));
  fireEvent.click(screen.getByRole('dialog').querySelector('button.danger')!);
  await waitFor(() => expect(useFiles.getState().buffers[fileKey('r', 'a.txt')]).toBeUndefined());
  expect(api.files.delete).toHaveBeenCalledWith('r', 'a.txt');
});

it('preserves buffers and selection when rename fails', async () => {
  vi.mocked(api.files.rename).mockRejectedValue({ code: 'files.exists' });
  show();
  fireEvent.click(await screen.findByRole('treeitem', { name: 'a.txt' }));
  await waitFor(() => expect(useFiles.getState().buffers[fileKey('r', 'a.txt')]).toBeTruthy());
  act(() => useFiles.getState().edit(fileKey('r', 'a.txt'), 'unsaved'));
  fireEvent.click(screen.getByRole('button', { name: '重命名' }));
  await nameAndSubmit('taken.txt');
  await waitFor(() => expect(useApp.getState().toasts.length).toBe(1));
  expect(useFiles.getState().selected.r).toBe('a.txt');
  expect(useFiles.getState().buffers[fileKey('r', 'a.txt')].text).toBe('unsaved');
  expect(useFiles.getState().buffers[fileKey('r', 'a.txt')].saving).toBe(false);
});

it('does not recreate a file over a stale open buffer', async () => {
  show();
  await screen.findByRole('treeitem', { name: 'a.txt' });
  act(() => {
    useFiles.getState().load('r', 'missing.txt', source);
    useFiles.getState().edit(fileKey('r', 'missing.txt'), 'preserve me');
  });
  fireEvent.click(screen.getByRole('button', { name: '新建文件' }));
  await nameAndSubmit('missing.txt');
  await waitFor(() => expect(useApp.getState().toasts.length).toBe(1));
  expect(api.files.create).not.toHaveBeenCalled();
  expect(useFiles.getState().buffers[fileKey('r', 'missing.txt')].text).toBe('preserve me');
});

it('does not drop buffers when deletion fails', async () => {
  vi.mocked(api.files.delete).mockRejectedValue({ code: 'files.notEmpty' });
  show();
  fireEvent.click(await screen.findByRole('treeitem', { name: 'src' }));
  act(() => useFiles.getState().load('r', 'src/keep.txt', source));
  fireEvent.contextMenu(screen.getByRole('treeitem', { name: 'src' }));
  fireEvent.click(screen.getByRole('menuitem', { name: '删除' }));
  fireEvent.click(screen.getByRole('dialog').querySelector('button.danger')!);
  await waitFor(() => expect(useApp.getState().toasts.length).toBe(1));
  expect(useFiles.getState().buffers[fileKey('r', 'src/keep.txt')]).toBeTruthy();
});
