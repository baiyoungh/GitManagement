// 与 src-tauri/src/sync_engine.rs 中的 glob_match / matching_rules 保持一致，用于规则编辑器中的即时预览。
import type { SyncRule } from '../api/types';

export const isWildcard = (pattern: string) => /[*?]/.test(pattern);

export function globMatch(pattern: string, name: string): boolean {
  if (pattern.endsWith('/*')) {
    const prefix = pattern.slice(0, -2);
    if (!isWildcard(prefix)) return name.length > prefix.length + 1 && name.startsWith(prefix + '/');
  }
  const p = [...pattern];
  const n = [...name];
  const rec = (pi: number, ni: number): boolean => {
    if (pi === p.length) return ni === n.length;
    if (p[pi] === '*') {
      const double = p[pi + 1] === '*';
      const rest = double ? pi + 2 : pi + 1;
      for (let i = ni; i <= n.length; i++) {
        if (rec(rest, i)) return true;
        if (i < n.length && !double && n[i] === '/') return false;
      }
      return false;
    }
    if (ni === n.length) return false;
    if (p[pi] === '?') return n[ni] !== '/' && rec(pi + 1, ni + 1);
    return p[pi] === n[ni] && rec(pi + 1, ni + 1);
  };
  return rec(0, 0);
}

export function ruleMatches(rule: Pick<SyncRule, 'branchPattern'>, branch: string): boolean {
  return isWildcard(rule.branchPattern) ? globMatch(rule.branchPattern, branch) : rule.branchPattern === branch;
}

/** 按优先级排序的匹配规则：精确名优先，同为通配按 order 升序 */
export function matchingRules<T extends Pick<SyncRule, 'branchPattern' | 'order'>>(rules: T[], branch: string): T[] {
  return rules
    .filter((r) => ruleMatches(r, branch))
    .sort((a, b) => Number(isWildcard(a.branchPattern)) - Number(isWildcard(b.branchPattern)) || a.order - b.order);
}

export const expandBranch = (template: string, branch: string) => template.split('${branch}').join(branch);
