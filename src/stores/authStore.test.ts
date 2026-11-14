import { beforeEach, expect, it } from 'vitest';
import { useAuth } from './authStore';
import type { AuthChallenge } from '../api/types';
const challenge = (id: string): AuthChallenge => ({ id, taskId: 'task', url: 'https://example.com', kind: 'https', username: null, profiles: [], error: null, expiresAt: Date.now() + 60_000 });
beforeEach(() => useAuth.setState({ challenges: {}, resolved: {}, activeId: null, cloneRetries: {} }));
it('never resurrects resolved prompts from a delayed snapshot or event', () => {
  useAuth.getState().resolve('one');
  useAuth.getState().mergePending([challenge('one'), challenge('two')]);
  useAuth.getState().upsert(challenge('one'));
  expect(Object.keys(useAuth.getState().challenges)).toEqual(['two']);
  expect(useAuth.getState().activeId).toBe('two');
});
it('preserves newer event data over snapshot data and supports deferral', () => {
  useAuth.getState().upsert({ ...challenge('one'), error: 'credential.rejected' });
  useAuth.getState().mergePending([challenge('one')]);
  expect(useAuth.getState().challenges.one.error).toBe('credential.rejected');
  useAuth.getState().defer();
  expect(useAuth.getState().activeId).toBeNull();
  expect(useAuth.getState().challenges.one).toBeDefined();
  useAuth.getState().open('one');
  expect(useAuth.getState().activeId).toBe('one');
});
it('ignores expired challenges', () => {
  useAuth.getState().upsert({ ...challenge('old'), expiresAt: Date.now() - 1 });
  expect(useAuth.getState().challenges).toEqual({});
});
