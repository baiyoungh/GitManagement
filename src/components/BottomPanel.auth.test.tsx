import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import i18n from '../i18n';
import { api } from '../api';
import { useApp } from '../stores/appStore';
import { useAuth } from '../stores/authStore';
import { useTasks } from '../stores/taskStore';
import { BottomPanel } from './BottomPanel';
vi.mock('./TerminalPanel', () => ({ TerminalPanel: () => null }));
beforeEach(async () => {
  await i18n.changeLanguage('en-US');
  useApp.setState({ bottomOpen: true, bottomTab: 'tasks', dialog: null });
  useAuth.setState({ challenges: {}, activeId: null, resolved: {}, cloneRetries: {} });
  useTasks.setState({ tasks: { task: { id: 'task', repoId: null, kind: 'clone', params: { url: 'https://example.com/repo' }, state: 'running', percent: null, message: '', startedAt: 1, error: null, output: null } } });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it('derives waiting status without changing running state and reopens the prompt', async () => {
  const cancel = vi.spyOn(api.task, 'cancel').mockResolvedValue(true);
  useAuth.getState().upsert({ id: 'auth', taskId: 'task', url: 'https://example.com', kind: 'https', username: null, profiles: [], error: null, expiresAt: Date.now() + 60_000 });
  useAuth.getState().defer();
  render(<BottomPanel />);
  expect(screen.getByText('Waiting for authentication')).toBeDefined();
  expect(useTasks.getState().tasks.task.state).toBe('running');
  fireEvent.click(screen.getByRole('button', { name: 'Authenticate…' }));
  expect(useAuth.getState().activeId).toBe('auth');
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(cancel).toHaveBeenCalledWith('task'));
});
it('opens an editable nonsecret clone retry and never reruns automatically', () => {
  const clone = vi.spyOn(api.task, 'clone');
  const retry = { url: 'https://example.com/repo', dest: '/work/repo', branch: 'main', name: 'Repo' };
  useAuth.getState().rememberClone('task', retry);
  const task = useTasks.getState().tasks.task;
  useTasks.getState().upsert({ ...task, state: 'failed', error: { code: 'git.authFailed', params: {} } });
  render(<BottomPanel />);
  fireEvent.click(screen.getByRole('button', { name: 'Review clone and retry…' }));
  expect(useApp.getState().dialog).toEqual({ type: 'clone', initial: retry });
  expect(clone).not.toHaveBeenCalled();
});
