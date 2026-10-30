import { describe, expect, it } from 'vitest';
import { insideRepo, parentRepo, repoFolder, sameRepoPath } from './repoPaths';

describe('repository paths', () => {
  it('finds the closest enclosing repository without matching sibling prefixes', () => {
    const root = { path: '/project' }, child = { path: '/project/services/a' };
    expect(parentRepo('/project/services/a/plugins/b', [root, child])).toBe(child);
    expect(parentRepo('/project-other/a', [root, child])).toBeUndefined();
    expect(parentRepo('/project', [root])).toBeUndefined();
    expect(insideRepo('/project/a', '/project/')).toBe(true);
  });
  it('handles Windows separators and drive casing', () => {
    expect(insideRepo('C:\\Code\\App\\child', 'c:/code/app/')).toBe(true);
    expect(sameRepoPath('C:\\Code\\App', 'c:/code/app/')).toBe(true);
    expect(sameRepoPath('/repo/A', '/repo/a')).toBe(false);
    expect(insideRepo('/child', '/')).toBe(true);
  });
  it('keeps the actual folder independent of the display name', () => {
    expect(repoFolder('/projects/actual-folder/')).toBe('actual-folder');
    expect(repoFolder('C:\\Code\\actual-folder')).toBe('actual-folder');
  });
});
