import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
async function chooseChild() {
  const family = await screen.findByRole('navigation', { name: '当前仓库及子仓库' });
  fireEvent.click(within(family).getByText('Child').closest('button')!);
  await waitFor(() => expect(api.branch.list).toHaveBeenCalledWith('child'));
  return screen.findByRole('button', { name: 'feature' });
}

it('creates a branch from the nested repository remote rather than the parent', async () => {
  show(<BranchPopup repoId="root" />);
  fireEvent.click(await chooseChild());
  fireEvent.click(screen.getByRole('menuitem', { name: '从「origin/feature」新建分支…' }));
  expect(useApp.getState().dialog).toEqual({ type: 'createBranch', repoId: 'child', startPoint: 'refs/remotes/origin/feature' });
});

it('checks out a remote in the child and keeps the parent view selected', async () => {
  vi.spyOn(api.branch, 'checkoutRemote').mockResolvedValue('feature');
  show(<BranchPopup repoId="root" />);
  fireEvent.click(await chooseChild());
  fireEvent.click(screen.getByRole('menuitem', { name: '检出' }));
  await waitFor(() => expect(api.branch.checkoutRemote).toHaveBeenCalledWith('child', 'origin', 'feature'));
  expect(useApp.getState().selectedRepoId).toBe('root');
});

it('discovers and registers an unlisted child only when it is selected', async () => {
  vi.mocked(api.repo.list).mockResolvedValue([root]);
  vi.spyOn(api.repo, 'add').mockImplementation(async () => { vi.mocked(api.repo.list).mockResolvedValue([root, child]); return child; });
  show(<BranchPopup repoId="root" />);
  await chooseChild();
  expect(api.scan.run).toHaveBeenCalledWith('/project', 8);
  expect(api.repo.add).toHaveBeenCalledWith(child.path, false);
  expect(screen.getByText('分支 · Child')).toBeTruthy();
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
