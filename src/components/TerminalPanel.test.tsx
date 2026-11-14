import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import '../i18n';
import { api } from '../api';
import { queryClient } from '../api/queries';
import { useApp } from '../stores/appStore';
import { TerminalPanel } from './TerminalPanel';
import { PromptHost } from './ui';

vi.mock('@xterm/xterm', () => ({ Terminal: class {
  input?: (data: string) => void;
  cols = 80; rows = 24; options = {}; loadAddon() {} open() {} dispose() {} clear() {} focus() {}
  onData(callback: (data: string) => void) { this.input = callback; return { dispose() {} }; }
  write(data: Uint8Array, done: () => void) {
    if (new TextDecoder().decode(data) === '\x1b[6n') this.input?.('\x1b[1;1R');
    done();
  }
} }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));

beforeEach(() => {
  queryClient.clear();
  useApp.setState({ selectedRepoId: 'a', settings: {}, promptReq: null });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.spyOn(api.repo, 'list').mockResolvedValue([
    { id: 'a', name: 'Repo A', path: '/repo-a', missing: false },
    { id: 'b', name: 'Repo B', path: '/repo-b', missing: false },
  ] as never);
  vi.spyOn(api.terminal, 'open').mockResolvedValue();
  vi.spyOn(api.terminal, 'close').mockResolvedValue();
  vi.spyOn(api.terminal, 'resize').mockResolvedValue();
  vi.spyOn(api.terminal, 'input').mockResolvedValue();
  vi.spyOn(api.terminal, 'ack').mockResolvedValue();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function panel(visible: boolean) { return <QueryClientProvider client={queryClient}><TerminalPanel visible={visible} /><PromptHost /></QueryClientProvider>; }

describe('terminal sessions', () => {
  it('names sessions by folder, selects new sessions and closes tabs independently', async () => {
    render(panel(true));
    await screen.findByRole('tab', { name: 'repo-a' });
    fireEvent.click(screen.getByRole('button', { name: '新建终端' }));
    const second = await screen.findByRole('tab', { name: 'repo-a / 2' });
    await waitFor(() => expect(api.terminal.open).toHaveBeenCalledTimes(2));
    expect(second.getAttribute('aria-selected')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: '关闭终端 repo-a' }));
    expect(screen.getByRole('tab', { name: 'repo-a / 2' }).getAttribute('aria-selected')).toBe('true');
    await waitFor(() => expect(api.terminal.close).toHaveBeenCalledTimes(1));
    act(() => useApp.getState().selectRepo('b'));
    expect(await screen.findByRole('tab', { name: 'repo-b' })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: 'repo-b / 3' })).toBeNull();
  });
  it('keeps the last terminal closed across panel hide and repository switches', async () => {
    const view = render(panel(true));
    fireEvent.click(await screen.findByRole('button', { name: '关闭终端 repo-a' }));
    await screen.findByText('没有打开的终端会话。');
    view.rerender(panel(false));
    view.rerender(panel(true));
    expect(screen.queryByRole('tab')).toBeNull();
    act(() => useApp.getState().selectRepo('b'));
    await screen.findByRole('tab', { name: 'repo-b' });
    act(() => useApp.getState().selectRepo('a'));
    expect(await screen.findByText('没有打开的终端会话。')).toBeTruthy();
    expect(api.terminal.open).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getAllByRole('button', { name: '新建终端' })[0]);
    expect(await screen.findByRole('tab', { name: 'repo-a / 2' })).toBeTruthy();
  });
  it('selects the nearest remaining tab when the active terminal is closed', async () => {
    render(panel(true));
    await screen.findByRole('tab', { name: 'repo-a' });
    fireEvent.click(screen.getByRole('button', { name: '新建终端' }));
    fireEvent.click(screen.getByRole('button', { name: '新建终端' }));
    fireEvent.click(screen.getByRole('tab', { name: 'repo-a / 2' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '关闭终端 repo-a / 2' })); });
    expect(screen.getByRole('tab', { name: 'repo-a / 3' }).getAttribute('aria-selected')).toBe('true');
  });
  it('renames a session without restarting its shell and supports middle-click close', async () => {
    render(panel(true));
    const tab = await screen.findByRole('tab', { name: 'repo-a' });
    fireEvent.doubleClick(tab);
    const input = screen.getByRole('textbox', { name: '终端名称' });
    fireEvent.change(input, { target: { value: '开发服务' } });
    fireEvent.submit(input.closest('form')!);
    const renamed = await screen.findByRole('tab', { name: '开发服务' });
    expect(api.terminal.open).toHaveBeenCalledTimes(1);
    fireEvent(renamed, new MouseEvent('auxclick', { bubbles: true, button: 1 }));
    await screen.findByText('没有打开的终端会话。');
    await waitFor(() => expect(api.terminal.close).toHaveBeenCalledTimes(1));
  });
  it('allows restarting an exited session in the same tab', async () => {
    render(panel(true));
    await waitFor(() => expect(api.terminal.open).toHaveBeenCalledTimes(1));
    act(() => vi.mocked(api.terminal.open).mock.calls[0][4]({ type: 'exit', code: 0 }));
    fireEvent.click(await screen.findByRole('button', { name: '重新启动' }));
    await waitFor(() => expect(api.terminal.open).toHaveBeenCalledTimes(2));
    expect(screen.getAllByRole('tab')).toHaveLength(1);
    expect(api.terminal.close).toHaveBeenCalledTimes(1);
  });
  it('enforces the session limit and keeps the new action available after closing a tab', async () => {
    render(panel(true));
    await screen.findByRole('tab', { name: 'repo-a' });
    for (let i = 1; i < 12; i++) await act(async () => { fireEvent.click(screen.getByRole('button', { name: '新建终端' })); });
    expect(screen.getAllByRole('tab')).toHaveLength(12);
    expect((screen.getByRole('button', { name: '新建终端' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '关闭终端 repo-a / 12' })); });
    expect((screen.getByRole('button', { name: '新建终端' }) as HTMLButtonElement).disabled).toBe(false);
  });
  it('answers cursor queries while the session open call is still pending', async () => {
    let resolve!: () => void;
    vi.mocked(api.terminal.open).mockImplementation((_repoId, _id, _cols, _rows, onEvent) => {
      onEvent({ type: 'data', data: [27, 91, 54, 110] });
      return new Promise<void>((done) => { resolve = done; });
    });
    const view = render(panel(true));
    await waitFor(() => expect(api.terminal.open).toHaveBeenCalledTimes(1));
    const id = vi.mocked(api.terminal.open).mock.calls[0][1];
    await waitFor(() => expect(api.terminal.input).toHaveBeenCalledWith(id, '\x1b[1;1R'));
    await act(async () => resolve());
    view.unmount();
    await waitFor(() => expect(api.terminal.close).toHaveBeenCalledWith(id));
  });
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
    fireEvent.click(screen.getByRole('button', { name: '关闭终端 repo-a' }));
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
