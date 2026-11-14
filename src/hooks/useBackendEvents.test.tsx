import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { listen } from '@tauri-apps/api/event';
import i18n from '../i18n';
import { api } from '../api';
import type { AuthChallenge } from '../api/types';
import { useAuth } from '../stores/authStore';
import { useApp } from '../stores/appStore';
import { useBackendEvents } from './useBackendEvents';
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
const challenge: AuthChallenge = { id: 'one', taskId: 'task', url: 'https://example.com', kind: 'https', username: null, profiles: [], error: null, expiresAt: Date.now() + 60_000 };
let handlers: Record<string, (event: { payload: unknown }) => void>;
beforeEach(async () => {
  await i18n.changeLanguage('en-US');
  handlers = {};
  useAuth.setState({ challenges: {}, resolved: {}, activeId: null });
  useApp.setState({ toasts: [] });
  vi.mocked(listen).mockImplementation(((name: string, callback: (event: { payload: unknown }) => void) => {
    handlers[name] = callback;
    return Promise.resolve(vi.fn());
  }) as unknown as typeof listen);
  vi.spyOn(api.task, 'list').mockResolvedValue([]);
  vi.spyOn(api.log, 'list').mockResolvedValue([]);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it('subscribes before snapshot, merges new challenges and never resurrects resolved ids', async () => {
  let finish!: (items: AuthChallenge[]) => void;
  const pending = vi.spyOn(api.auth, 'pending').mockImplementation(() => {
    expect(handlers['auth-challenge']).toBeDefined();
    expect(handlers['auth-resolved']).toBeDefined();
    return new Promise((resolve) => { finish = resolve; });
  });
  renderHook(useBackendEvents);
  await waitFor(() => expect(pending).toHaveBeenCalled());
  act(() => {
    handlers['auth-challenge']({ payload: { ...challenge, id: 'new', error: 'credential.rejected' } });
    handlers['auth-resolved']({ payload: { id: 'one' } });
  });
  await act(async () => { finish([challenge, { ...challenge, id: 'new' }]); });
  expect(Object.keys(useAuth.getState().challenges)).toEqual(['new']);
  expect(useAuth.getState().challenges.new.error).toBe('credential.rejected');
});
it('surfaces keyring failure as localized nonsecret warning', async () => {
  vi.spyOn(api.auth, 'pending').mockResolvedValue([]);
  renderHook(useBackendEvents);
  act(() => handlers['auth-warning']({ payload: { code: 'credential.saveFailed' } }));
  expect(useApp.getState().toasts[0].message).toContain('could not be saved');
});
