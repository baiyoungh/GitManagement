import { describe, expect, it } from 'vitest';
import { cloneRetry, credentialOrigin, isHttps, matchingProfiles } from './credentials';

const profiles = [
  { id: 'one', name: 'Work', url: 'https://EXAMPLE.com:443/group', username: 'alice' },
  { id: 'two', name: 'Other port', url: 'https://example.com:8443', username: 'bob' },
];
describe('HTTPS credential matching', () => {
  it('normalizes case, default ports and paths, but not protocols or other ports', () => {
    expect(matchingProfiles('https://example.com/repo.git', profiles).map((p) => p.id)).toEqual(['one']);
    expect(matchingProfiles('https://example.com:8443/a', profiles).map((p) => p.id)).toEqual(['two']);
    expect(matchingProfiles('http://example.com', profiles)).toEqual([]);
    expect(matchingProfiles('https://alice@example.com/repo', profiles).map((p) => p.id)).toEqual(['one']);
    expect(matchingProfiles('https://b%6Fb@example.com:8443/repo', profiles).map((p) => p.id)).toEqual(['two']);
    expect(matchingProfiles('https://bob@example.com/repo', profiles)).toEqual([]);
    expect(matchingProfiles('https://example.com.evil.test', profiles)).toEqual([]);
    expect(credentialOrigin('git@example.com:a.git')).toBeNull();
    expect(isHttps('ssh://git@example.com/a')).toBe(false);
  });
  it('retains only nonsecret clone retry fields', () => {
    expect(cloneRetry({ url: 'ssh://git@example.com/repo', dest: '/a' }).url).toBe('ssh://git@example.com/repo');
    expect(cloneRetry({ url: 'https://alice:token@example.com/repo.git?token=secret#secret', dest: '/a', credentialId: 'one', credential: { username: 'alice', secret: 'secret', remember: true } })).toEqual({ url: 'https://example.com/repo.git', dest: '/a', branch: undefined, depth: undefined, name: undefined });
  });
});
