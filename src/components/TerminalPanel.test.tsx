import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import '../i18n';
import { api } from '../api';
import { queryClient } from '../api/queries';
import { useApp } from '../stores/appStore';
import { TerminalPanel } from './TerminalPanel';

vi.mock('@xterm/xterm', () => ({ Terminal: class {
  cols = 80; rows = 24; options = {}; loadAddon() {} open() {} dispose() {} clear() {} focus() {}
  onData() { return { dispose() {} }; } write(_data: unknown, done: () => void) { done(); }
} }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));

beforeEach(() => {
  queryClient.clear();
  useApp.setState({ selectedRepoId: 'a', settings: {} });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.spyOn(api.repo, 'list').mockResolvedValue([
    { id: 'a', name: 'Repo A', path: '/repo-a', missing: false },
    { id: 'b', name: 'Repo B', path: '/repo-b', missing: false },
  ] as never);
  vi.spyOn(api.terminal, 'open').mockResolvedValue();
  vi.spyOn(api.terminal, 'close').mockResolvedValue();
  vi.spyOn(api.terminal, 'resize').mockResolvedValue();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function panel(visible: boolean) { return <QueryClientProvider client={queryClient}><TerminalPanel visible={visible} /></QueryClientProvider>; }

describe('terminal sessions', () => {
  it('opens for the selected repository, retains sessions while hidden and isolates repositories', async () => {
    const view = render(panel(true));
    await waitFor(() => expect(api.terminal.open).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.terminal.open).mock.calls[0][0]).toBe('a');
    view.rerender(panel(false));
    expect(api.terminal.close).not.toHaveBeenCalled();
    view.rerender(panel(true));
    await waitFor(() => expect(api.terminal.open).toHaveBeenCalledTimes(1));
    act(() => useApp.getState().selectRepo('b'));
    await waitFor(() => expect(api.terminal.open).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.terminal.open).mock.calls[1][0]).toBe('b');
    act(() => useApp.getState().selectRepo('a'));
    await waitFor(() => expect(screen.getByText('/repo-a')).toBeTruthy());
    expect(api.terminal.open).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', { name: '关闭终端会话' }));
    await waitFor(() => expect(api.terminal.close).toHaveBeenCalledTimes(1));
    view.unmount();
    await waitFor(() => expect(api.terminal.close).toHaveBeenCalledTimes(2));
  });
  it('closes a session when an in-flight open resolves after unmount', async () => {
    let resolve!: () => void;
    vi.mocked(api.terminal.open).mockImplementation(() => new Promise<void>((done) => { resolve = done; }));
    const view = render(panel(true));
    await waitFor(() => expect(api.terminal.open).toHaveBeenCalledTimes(1));
    const id = vi.mocked(api.terminal.open).mock.calls[0][1];
    view.unmount();
    resolve();
    await waitFor(() => expect(api.terminal.close).toHaveBeenCalledWith(id));
  });
});
