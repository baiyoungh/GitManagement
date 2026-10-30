function comparablePath(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[a-z]:\//i.test(normalized) || normalized.startsWith('//') ? normalized.toLowerCase() : normalized;
}

export function repoFolder(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path;
}

export function sameRepoPath(a: string, b: string): boolean {
  return comparablePath(a) === comparablePath(b);
}

export function insideRepo(path: string, root: string): boolean {
  const child = comparablePath(path);
  const parent = comparablePath(root);
  return child !== parent && child.startsWith(parent + '/');
}

/** Closest enclosing repository, with directory boundaries preserved. */
export function parentRepo<T extends { path: string }>(path: string, repos: readonly T[]): T | undefined {
  const child = comparablePath(path);
  let parent: T | undefined;
  let length = -1;
  for (const repo of repos) {
    const candidate = comparablePath(repo.path);
    if (child !== candidate && child.startsWith(candidate + '/') && candidate.length > length) {
      parent = repo;
      length = candidate.length;
    }
  }
  return parent;
}
