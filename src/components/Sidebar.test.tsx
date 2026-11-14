import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import i18n from '../i18n';
import { api } from '../api';
import { keys, queryClient } from '../api/queries';
import type { RepoView } from '../api/types';
import { useApp } from '../stores/appStore';
import { Sidebar } from './Sidebar';
import { ConfirmHost, PromptHost } from './ui';

beforeEach(() => {
  queryClient.clear();
  useApp.setState({ selectedRepoId: 'root', multiSelected: [], dialog: null, confirm: null, promptReq: null, toasts: [] });
  vi.spyOn(api.repo, 'list').mockResolvedValue([
    { id: 'root', name: 'Project Alias', path: '/workspace/actual-folder', groupId: null, missing: false },
    { id: 'child', name: 'Child Alias', path: '/workspace/actual-folder/services/child', groupId: null, missing: false },
  ] as never);
  vi.spyOn(api.group, 'list').mockResolvedValue([]);
  vi.spyOn(api.repo, 'summary').mockResolvedValue({ branch: 'main', ahead: 0, behind: 0 } as never);
  vi.spyOn(api.repo, 'rename').mockResolvedValue();
});
afterEach(() => { cleanup(); queryClient.clear(); vi.restoreAllMocks(); });

function show() { render(<QueryClientProvider client={queryClient}><Sidebar /><PromptHost /><ConfirmHost /></QueryClientProvider>); }

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

/** WebKit 在 dragover 期间读不到自定义 dataTransfer 类型，因此这里模拟一个空的 dataTransfer */
function dragData() {
  const store: Record<string, string> = {};
  return {
    types: [] as string[],
    effectAllowed: '',
    setData: (type: string, value: string) => { store[type] = value; },
    getData: (type: string) => store[type] ?? '',
  } as unknown as DataTransfer;
}

it('moves a repository to another group by dragging it onto that group', async () => {
  vi.mocked(api.repo.list).mockResolvedValue([
    { id: 'a', name: 'Alpha', path: '/w/a', groupId: 'g1', missing: false },
    { id: 'b', name: 'Beta', path: '/w/b', groupId: 'g2', missing: false },
  ] as never);
  vi.mocked(api.group.list).mockResolvedValue([
    { id: 'g1', name: 'Group One', sort: 0, collapsed: false },
    { id: 'g2', name: 'Group Two', sort: 1, collapsed: false },
  ] as never);
  const move = vi.spyOn(api.group, 'moveRepos').mockResolvedValue();
  show();
  const repo = (await screen.findByText('Alpha')).closest('li')!;
  const target = screen.getByRole('button', { name: /Group Two/ }).closest('section')!;
  const data = dragData();
  fireEvent.dragStart(repo, { dataTransfer: data });
  fireEvent.dragOver(target, { dataTransfer: data });
  fireEvent.drop(target, { dataTransfer: data });
  await waitFor(() => expect(move).toHaveBeenCalledWith('g2', ['b', 'a']));
  expect(api.repo.list).toHaveBeenCalledTimes(2);
});

describe('repository record removal', () => {
  let records: RepoView[];
  let removed: Set<string>;

  beforeEach(async () => {
    await act(async () => { await i18n.changeLanguage('en-US'); });
    records = [
      { id: 'a', name: 'Visible Alpha', path: '/w/a', groupId: 'g1', favorite: false, missing: false },
      { id: 'b', name: 'Hidden Beta', path: '/w/b', groupId: 'g1', favorite: false, missing: false },
      { id: 'fav', name: 'Favorite Gamma', path: '/w/fav', groupId: 'g1', favorite: true, missing: false },
      { id: 'outside', name: 'Other Delta', path: '/w/outside', groupId: 'g2', favorite: false, missing: false },
    ] as RepoView[];
    removed = new Set();
    vi.mocked(api.repo.list).mockImplementation(async () => records.filter((repo) => !removed.has(repo.id)));
    vi.mocked(api.group.list).mockResolvedValue([
      { id: 'g1', name: 'Group One', sort: 0, collapsed: false },
      { id: 'g2', name: 'Group Two', sort: 1, collapsed: false },
      { id: 'empty', name: 'Empty Group', sort: 2, collapsed: false },
    ]);
    vi.spyOn(api.repo, 'remove').mockImplementation(async (id) => { removed.add(id); });
    vi.spyOn(api.group, 'delete').mockResolvedValue();
    useApp.setState({ selectedRepoId: 'a', multiSelected: ['a', 'b', 'outside'] });
  });
  afterEach(async () => { await act(async () => { await i18n.changeLanguage('zh-CN'); }); });

  async function openGroupRemoval() {
    const group = await screen.findByRole('button', { name: /Group One/ });
    fireEvent.contextMenu(group);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove all 3 repositories from list…' }));
    return screen.getByRole('dialog');
  }

  it('does nothing before confirmation or after canceling a group removal', async () => {
    show();
    const dialog = await openGroupRemoval();
    expect(api.repo.remove).not.toHaveBeenCalled();
    expect(within(dialog).getByText(/Group One/, { selector: 'h2' }).textContent).toContain('3');
    expect(within(dialog).getByText(/Files on disk will remain unchanged/).textContent).toContain('The group itself will be retained.');
    expect(within(dialog).getByText('Favorite Gamma — /w/fav')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.repo.remove).not.toHaveBeenCalled();
    expect(api.repo.list).toHaveBeenCalledTimes(1);
    expect(useApp.getState().selectedRepoId).toBe('a');
    expect(useApp.getState().multiSelected).toEqual(['a', 'b', 'outside']);
    expect(api.group.delete).not.toHaveBeenCalled();
  });

  it('removes all registered group members, including favorites and search-hidden repositories, but keeps the group', async () => {
    show();
    await screen.findByText('Favorite Gamma');
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Visible Alpha' } });
    expect(screen.queryByText('Hidden Beta')).toBeNull();
    expect(screen.queryByText('Favorite Gamma')).toBeNull();
    const dialog = await openGroupRemoval();
    expect(within(dialog).getAllByRole('listitem')).toHaveLength(3);
    expect(api.repo.remove).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(api.repo.list).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.repo.remove).mock.calls).toEqual([['a'], ['b'], ['fav']]);
    expect(useApp.getState().selectedRepoId).toBeNull();
    expect(useApp.getState().multiSelected).toEqual(['outside']);
    expect(queryClient.getQueryData<RepoView[]>(keys.repos)?.map((repo) => repo.id)).toEqual(['outside']);
    expect(screen.getByRole('button', { name: /Group One/ })).toBeTruthy();
    expect(api.group.delete).not.toHaveBeenCalled();
  });

  it('refreshes after partial failure, attempts every record and retains failed and unrelated selections', async () => {
    vi.mocked(api.repo.remove).mockImplementation(async (id) => {
      if (id === 'b') throw new Error('Cannot remove Beta');
      removed.add(id);
    });
    show();
    const dialog = await openGroupRemoval();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(api.repo.list).toHaveBeenCalledTimes(2));
    expect(api.repo.remove).toHaveBeenCalledTimes(3);
    expect(useApp.getState().selectedRepoId).toBeNull();
    expect(useApp.getState().multiSelected).toEqual(['b', 'outside']);
    expect(useApp.getState().toasts.some((toast) => toast.message.includes('Cannot remove Beta'))).toBe(true);
    expect(queryClient.getQueryData<RepoView[]>(keys.repos)?.map((repo) => repo.id)).toEqual(['b', 'outside']);
  });

  it('refreshes even if every removal fails and preserves the current repository and selections', async () => {
    vi.mocked(api.repo.remove).mockRejectedValue(new Error('Removal failed'));
    show();
    const dialog = await openGroupRemoval();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(api.repo.list).toHaveBeenCalledTimes(2));
    expect(api.repo.remove).toHaveBeenCalledTimes(3);
    expect(useApp.getState().selectedRepoId).toBe('a');
    expect(useApp.getState().multiSelected).toEqual(['a', 'b', 'outside']);
  });

  it('requires confirmation from the multi-select right-click menu and removes only selected records', async () => {
    useApp.setState({ multiSelected: ['a', 'fav'] });
    show();
    fireEvent.contextMenu((await screen.findByText('Visible Alpha')).closest('button')!);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove 2 repositories from list…' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/Files on disk and groups will remain unchanged/)).toBeTruthy();
    expect(api.repo.remove).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(api.repo.list).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.repo.remove).mock.calls).toEqual([['a'], ['fav']]);
    expect(useApp.getState().selectedRepoId).toBeNull();
    expect(useApp.getState().multiSelected).toEqual([]);
  });

  it('uses the batch toolbar to remove hidden selected records without clearing an unrelated current repository', async () => {
    useApp.setState({ selectedRepoId: 'outside', multiSelected: ['a', 'b'] });
    show();
    await screen.findByText('Visible Alpha');
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Other Delta' } });
    fireEvent.click(within(screen.getByRole('toolbar')).getByRole('button', { name: 'Remove 2 repositories from list…' }));
    expect(api.repo.remove).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(api.repo.list).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.repo.remove).mock.calls).toEqual([['a'], ['b']]);
    expect(useApp.getState().selectedRepoId).toBe('outside');
    expect(useApp.getState().multiSelected).toEqual([]);
  });

  it('does not clear a new current selection made while removal is pending', async () => {
    let finish!: () => void;
    vi.mocked(api.repo.remove).mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    useApp.setState({ multiSelected: [] });
    show();
    fireEvent.contextMenu((await screen.findByText('Visible Alpha')).closest('button')!);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove from list…' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(api.repo.remove).toHaveBeenCalledWith('a'));
    act(() => useApp.setState({ selectedRepoId: 'outside', multiSelected: ['a', 'b'] }));
    await act(async () => { removed.add('a'); finish(); });
    expect(useApp.getState().selectedRepoId).toBe('outside');
    expect(useApp.getState().multiSelected).toEqual(['b']);
    expect(api.repo.list).toHaveBeenCalledTimes(2);
  });

  it('disables group removal for an empty registered group', async () => {
    show();
    fireEvent.contextMenu(await screen.findByRole('button', { name: /Empty Group/ }));
    const remove = screen.getByRole('menuitem', { name: 'Remove all 0 repositories from list…' });
    expect((remove as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(remove);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.repo.remove).not.toHaveBeenCalled();
  });
});
