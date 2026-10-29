// 把提交/比较中的文件条目转换为差异查看器需要的 FileChange
import type { CommitFile, FileChange } from '../api/types';

export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export function asFileChange(f: CommitFile): FileChange {
  const kind: FileChange['kind'] = f.status === 'A' ? 'added' : f.status === 'D' ? 'deleted' : f.status === 'R' ? 'renamed' : 'modified';
  return {
    path: f.path,
    origPath: f.oldPath,
    kind,
    indexStatus: '.',
    worktreeStatus: '.',
    staged: false,
    unstaged: false,
    conflict: null,
    submodule: false,
    added: null,
    removed: null,
  };
}
