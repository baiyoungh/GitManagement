import { describe, expect, it } from 'vitest';
import { expandBranch, globMatch, matchingRules } from './ruleMatch';

// 用例与 sync_engine.rs 的单测一致，保证前后端匹配行为相同
describe('ruleMatch', () => {
  it('glob', () => {
    expect(globMatch('feature/*', 'feature/login')).toBe(true);
    expect(globMatch('feature/*', 'feature/a/b')).toBe(true);
    expect(globMatch('feature/*', 'feature')).toBe(false);
    expect(globMatch('feature/*', 'featurex/a')).toBe(false);
    expect(globMatch('release-*', 'release-1.0')).toBe(true);
    expect(globMatch('*', 'a/b')).toBe(false);
    expect(globMatch('**', 'a/b')).toBe(true);
    expect(globMatch('hotfix/?', 'hotfix/1')).toBe(true);
    expect(globMatch('hotfix/?', 'hotfix/12')).toBe(false);
    expect(globMatch('*/x', 'a/x')).toBe(true);
  });

  it('priority', () => {
    const rules = [
      { id: 'w2', branchPattern: 'feature/*', order: 20 },
      { id: 'w1', branchPattern: '*', order: 10 },
      { id: 'exact', branchPattern: 'main', order: 99 },
      { id: 'w0', branchPattern: 'f*', order: 5 },
    ];
    expect(matchingRules(rules, 'main').map((r) => r.id)).toEqual(['exact', 'w1']);
    expect(matchingRules(rules, 'feature/a').map((r) => r.id)).toEqual(['w2']);
    expect(matchingRules(rules, 'x/y')).toEqual([]);
  });

  it('expand', () => {
    expect(expandBranch('${branch}', 'feature/x')).toBe('feature/x');
    expect(expandBranch('mirror/${branch}', 'main')).toBe('mirror/main');
  });
});
