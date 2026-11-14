import { describe, expect, it } from 'vitest';
import { containsPath, joinPath, parentPath, validFileName } from './filePaths';

describe('file management paths', () => {
  it('rejects unsafe and nonportable names', () => {
    for (const name of ['', '.', '..', '.GIT', '../escape', 'a/b', 'a\\b', 'a:b', 'bad\0', 'name.', 'name ', 'CON', 'nul.txt', 'COM1']) expect(validFileName(name), name).toBe(false);
    for (const name of ['notes.md', '.gitignore', '新文件.txt', 'my folder']) expect(validFileName(name), name).toBe(true);
  });
  it('matches only descendants and joins root and nested paths', () => {
    expect(containsPath('src', 'src/a')).toBe(true);
    expect(containsPath('src', 'src')).toBe(true);
    expect(containsPath('src', 'src-other/a')).toBe(false);
    expect(parentPath('file.txt')).toBe('');
    expect(parentPath('src/file.txt')).toBe('src');
    expect(joinPath('', 'a')).toBe('a');
    expect(joinPath('src', 'a')).toBe('src/a');
  });
});
