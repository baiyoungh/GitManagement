import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import '../i18n';
import { api } from '../api';
import { queryClient } from '../api/queries';
import { useApp } from '../stores/appStore';
import { BranchPopup } from './QuickPickers';
import { ScanDialog } from './ScanDialog';
import type { BranchInfo, RepoView } from '../api/types';

const root = { id: 'root', name: 'Parent', path: '/project', missing: false } as RepoView;
const child = { id: 'child', name: 'Child', path: '/project/services/child', missing: false } as RepoView;
const branch = (remote = false): BranchInfo => ({
  name: remote ? 'origin/feature' : 'main', fullRef: remote ? 'refs/remotes/origin/feature' : 'refs/heads/main',
  kind: remote ? 'remote' : 'local', remote: remote ? 'origin' : null, remoteBranch: remote ? 'feature' : null,
  oid: 'a'.repeat(40), isHead: !remote, upstream: null, ahead: 0, behind: 0,
} as BranchInfo);

beforeEach(() => {
  queryClient.clear();
  useApp.setState({ selectedRepoId: 'root', dialog: null, toasts: [] });
  vi.spyOn(api.repo, 'list').mockResolvedValue([root, child]);
  vi.spyOn(api.repo, 'summary').mockResolvedValue({ branch: 'main', ahead: 0, behind: 0 } as never);
  vi.spyOn(api.scan, 'run').mockResolvedValue({ repos: [{ ...root, linked: false, registered: true }, { ...child, linked: true, registered: true }], truncated: false });
  vi.spyOn(api.branch, 'list').mockResolvedValue([branch(), branch(true)]);
  vi.spyOn(api.status, 'get').mockResolvedValue({ branch: { head: 'main', oid: 'a'.repeat(40) } } as never);
  vi.spyOn(api.group, 'list').mockResolvedValue([]);
});
afterEach(() => { cleanup(); queryClient.clear(); vi.restoreAllMocks(); });
function show(element: React.ReactNode) { render(<QueryClientProvider client={queryClient}>{element}</QueryClientProvider>); }
async function selectedRemote() {
  return screen.findByRole('button', { name: 'feature' });
}

it('opens only the requested repository without a repository sidebar or nested scan', async () => {
  const add = vi.spyOn(api.repo, 'add');
  show(<BranchPopup repoId="child" />);
  await selectedRemote();
  expect(screen.getByRole('dialog', { name: '分支 · Child' })).toBeTruthy();
  expect(screen.queryByRole('navigation', { name: '当前仓库及子仓库' })).toBeNull();
  expect(screen.queryByRole('searchbox', { name: '搜索仓库' })).toBeNull();
  expect(api.branch.list).toHaveBeenCalledWith('child');
  expect(api.branch.list).not.toHaveBeenCalledWith('root');
  expect(api.scan.run).not.toHaveBeenCalled();
  expect(add).not.toHaveBeenCalled();
});

it('creates a branch in the requested child rather than its parent', async () => {
  show(<BranchPopup repoId="child" />);
  fireEvent.click(await selectedRemote());
  fireEvent.click(screen.getByRole('menuitem', { name: '从「origin/feature」新建分支…' }));
  expect(useApp.getState().dialog).toEqual({ type: 'createBranch', repoId: 'child', startPoint: 'refs/remotes/origin/feature' });
});

it('checks out a remote in the requested child and keeps the parent view selected', async () => {
  vi.spyOn(api.branch, 'checkoutRemote').mockResolvedValue('feature');
  show(<BranchPopup repoId="child" />);
  fireEvent.click(await selectedRemote());
  fireEvent.click(screen.getByRole('menuitem', { name: '检出' }));
  await waitFor(() => expect(api.branch.checkoutRemote).toHaveBeenCalledWith('child', 'origin', 'feature'));
  expect(useApp.getState().selectedRepoId).toBe('root');
});

it('scans the requested depth, excludes registered roots from import and clears stale results', async () => {
  vi.mocked(api.scan.run).mockResolvedValue({ repos: [{ ...root, linked: false, registered: true }, { ...child, linked: true, registered: false }], truncated: false });
  vi.spyOn(api.scan, 'addMany').mockResolvedValue({ added: [child], failed: [] });
  show(<ScanDialog initialRoot="/project" />);
  fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '5' } });
  fireEvent.click(screen.getByRole('button', { name: '扫描' }));
  await screen.findByText('子仓库');
  expect(api.scan.run).toHaveBeenCalledWith('/project', 5);
  fireEvent.click(screen.getByRole('button', { name: '导入 1 个' }));
  await waitFor(() => expect(api.scan.addMany).toHaveBeenCalledWith([child.path], null));
  fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '1' } });
  expect((screen.getByRole('button', { name: '导入 0 个' }) as HTMLButtonElement).disabled).toBe(true);
});
