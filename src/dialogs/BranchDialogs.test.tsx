import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '../i18n';
import { api } from '../api';
import type { BranchInfo } from '../api/types';
import { useApp } from '../stores/appStore';
import { CreateBranchDialog } from './BranchDialogs';
import { BranchPopup } from './QuickPickers';

const branch = (name: string, remote = false): BranchInfo => ({
  name, fullRef: remote ? `refs/remotes/${name}` : `refs/heads/${name}`, kind: remote ? 'remote' : 'local',
  remote: remote ? 'origin' : null, remoteBranch: remote ? name.slice(7) : null,
  oid: 'a'.repeat(40), isHead: name === 'main', upstream: null, upstreamRemote: null, upstreamBranch: null,
  upstreamGone: false, ahead: 0, behind: 0, committerTime: 0, subject: '',
});

beforeEach(() => {
  vi.spyOn(api.branch, 'list').mockResolvedValue([branch('main'), branch('feature'), branch('origin/prod', true)]);
  vi.spyOn(api.remote, 'list').mockResolvedValue([]);
  vi.spyOn(api.status, 'get').mockResolvedValue({ branch: { head: 'main', oid: 'a'.repeat(40) } } as Awaited<ReturnType<typeof api.status.get>>);
  vi.spyOn(api.branch, 'create').mockResolvedValue(undefined);
  useApp.setState({ dialog: null, toasts: [] });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function show(element: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
  return client;
}

describe('branch creation', () => {
  it('opens creation from the selected remote using its full ref', async () => {
    show(<BranchPopup repoId="repo" />);
    fireEvent.click(await screen.findByRole('button', { name: 'prod' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '从「origin/prod」新建分支…' }));
    expect(useApp.getState().dialog).toEqual({ type: 'createBranch', repoId: 'repo', startPoint: 'refs/remotes/origin/prod' });
    expect(api.branch.create).not.toHaveBeenCalled();
  });

  it('creates at the chosen remote ref without checking it out', async () => {
    show(<CreateBranchDialog repoId="repo" startPoint="refs/remotes/origin/prod" />);
    await screen.findByRole('option', { name: 'origin/prod' });
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('refs/remotes/origin/prod');
    fireEvent.change(screen.getByRole('textbox', { name: '分支名' }), { target: { value: 'feature/new' } });
    fireEvent.click(screen.getByRole('checkbox', { name: '创建后立即切换' }));
    fireEvent.click(screen.getByRole('button', { name: '确定' }));
    await waitFor(() => expect(api.branch.create).toHaveBeenCalledWith('repo', {
      name: 'feature/new', startPoint: 'refs/remotes/origin/prod', checkout: false, upstream: null,
    }));
  });

  it('switches source to a local branch and rejects duplicate names', async () => {
    show(<CreateBranchDialog repoId="repo" />);
    await screen.findByRole('option', { name: 'feature' });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'refs/heads/feature' } });
    const name = screen.getByRole('textbox', { name: '分支名' });
    fireEvent.change(name, { target: { value: 'main' } });
    expect((screen.getByRole('button', { name: '确定' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(name, { target: { value: 'new-local' } });
    fireEvent.submit(name.closest('form')!);
    await waitFor(() => expect(api.branch.create).toHaveBeenCalledWith('repo', expect.objectContaining({ startPoint: 'refs/heads/feature', checkout: true })));
  });

  it('prevents repeat submissions while creation is pending', async () => {
    let complete!: () => void;
    vi.mocked(api.branch.create).mockReturnValue(new Promise((resolve) => { complete = resolve; }));
    show(<CreateBranchDialog repoId="repo" />);
    const name = screen.getByRole('textbox', { name: '分支名' });
    fireEvent.change(name, { target: { value: 'new' } });
    fireEvent.submit(name.closest('form')!);
    fireEvent.submit(name.closest('form')!);
    expect(api.branch.create).toHaveBeenCalledTimes(1);
    complete();
    await waitFor(() => expect(screen.getByRole('button', { name: '确定' }).hasAttribute('disabled')).toBe(false));
  });
});
