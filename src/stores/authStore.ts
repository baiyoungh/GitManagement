import { create } from 'zustand';
import type { AuthChallenge } from '../api/types';
import type { CloneRetry } from '../lib/credentials';

interface AuthState {
  challenges: Record<string, AuthChallenge>;
  activeId: string | null;
  // Tombstones prevent a late auth_pending snapshot from resurrecting resolved prompts.
  resolved: Record<string, true>;
  cloneRetries: Record<string, CloneRetry>;
  upsert: (challenge: AuthChallenge) => void;
  mergePending: (challenges: AuthChallenge[]) => void;
  resolve: (id: string) => void;
  open: (id: string) => void;
  defer: () => void;
  rememberClone: (id: string, retry: CloneRetry) => void;
  forgetClone: (id: string) => void;
}

/** Nonsecret, in-memory only. Passwords never enter this store. */
export const useAuth = create<AuthState>((set, get) => ({
  challenges: {}, activeId: null, resolved: {}, cloneRetries: {},
  upsert: (challenge) => {
    if (get().resolved[challenge.id] || challenge.expiresAt <= Date.now()) return;
    set((s) => ({
      challenges: { ...s.challenges, [challenge.id]: challenge },
      activeId: s.activeId ?? challenge.id,
    }));
  },
  mergePending: (challenges) => challenges.forEach((challenge) => {
    // An event received after the snapshot began is newer than the snapshot.
    if (!get().challenges[challenge.id]) get().upsert(challenge);
  }),
  resolve: (id) => set((s) => {
    const challenges = { ...s.challenges };
    delete challenges[id];
    return {
      challenges, resolved: { ...s.resolved, [id]: true },
      activeId: s.activeId === id ? Object.keys(challenges)[0] ?? null : s.activeId,
    };
  }),
  open: (id) => { if (get().challenges[id]) set({ activeId: id }); },
  defer: () => set({ activeId: null }),
  rememberClone: (id, retry) => set((s) => ({ cloneRetries: { ...s.cloneRetries, [id]: retry } })),
  forgetClone: (id) => set((s) => {
    const cloneRetries = { ...s.cloneRetries };
    delete cloneRetries[id];
    return { cloneRetries };
  }),
}));
