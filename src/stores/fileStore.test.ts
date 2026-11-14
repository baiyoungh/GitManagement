import { beforeEach, describe, expect, it } from 'vitest';
import { fileKey, isDirty, useFiles } from './fileStore';
import type { FileDocument } from '../api';

const source: FileDocument = { text: 'original\n', revision: 'v1', size: 9, eol: 'LF', bom: false, readOnly: null };
const key = fileKey('repo-a', 'file.txt');
beforeEach(() => useFiles.setState({ buffers: {}, selected: {} }));

describe('file editing buffers', () => {
  it('renames directory buffers and selection without losing dirty text or affecting siblings/repos', () => {
    const s = useFiles.getState();
    for (const path of ['src/a.txt', 'src/nested/b.txt', 'src-other/c.txt']) s.load('repo-a', path, source);
    s.load('repo-b', 'src/a.txt', source);
    s.edit(fileKey('repo-a', 'src/a.txt'), 'unsaved');
    s.select('repo-a', 'src/a.txt');
    s.renamePath('repo-a', 'src', 'lib');
    expect(useFiles.getState().selected['repo-a']).toBe('lib/a.txt');
    expect(useFiles.getState().buffers[fileKey('repo-a', 'lib/a.txt')].text).toBe('unsaved');
    expect(useFiles.getState().buffers[fileKey('repo-a', 'src/a.txt')]).toBeUndefined();
    expect(useFiles.getState().buffers[fileKey('repo-a', 'lib/nested/b.txt')]).toBeTruthy();
    expect(useFiles.getState().buffers[fileKey('repo-a', 'src-other/c.txt')]).toBeTruthy();
    expect(useFiles.getState().buffers[fileKey('repo-b', 'src/a.txt')]).toBeTruthy();
  });
  it('removes only matching buffers and chooses a remaining tab', () => {
    const s = useFiles.getState();
    s.load('repo-a', 'keep.txt', source);
    s.load('repo-a', 'src/a.txt', source);
    s.load('repo-b', 'src/a.txt', source);
    s.select('repo-a', 'src/a.txt');
    s.removePath('repo-a', 'src');
    expect(useFiles.getState().selected['repo-a']).toBe('keep.txt');
    expect(useFiles.getState().buffers[fileKey('repo-a', 'src/a.txt')]).toBeUndefined();
    expect(useFiles.getState().buffers[fileKey('repo-b', 'src/a.txt')]).toBeTruthy();
  });
  it('keeps dirty edits isolated across files and repositories and external refresh', () => {
    const s = useFiles.getState();
    s.load('repo-a', 'file.txt', source);
    s.edit(key, 'my edits');
    s.select('repo-a', 'other.txt');
    s.select('repo-b', 'file.txt');
    s.load('repo-b', 'file.txt', { ...source, text: 'other repo' });
    s.load('repo-a', 'file.txt', { ...source, revision: 'external', text: 'external edit' });
    expect(useFiles.getState().buffers[key].text).toBe('my edits');
    expect(useFiles.getState().buffers[fileKey('repo-b', 'file.txt')].text).toBe('other repo');
    expect(isDirty(useFiles.getState().buffers[key])).toBe(true);
  });
  it('does not discard text typed while a save is in flight', () => {
    const s = useFiles.getState();
    s.load('repo-a', 'file.txt', source);
    s.edit(key, 'save this');
    s.saving(key, true);
    s.edit(key, 'newer edits');
    s.load('repo-a', 'file.txt', source);
    s.saved(key, { ...source, text: 'save this', revision: 'v2' });
    const buffer = useFiles.getState().buffers[key];
    expect(buffer.text).toBe('newer edits');
    expect(buffer.source.revision).toBe('v2');
    expect(isDirty(buffer)).toBe(true);
  });
  it('reloads deliberately and closes to the remaining file', () => {
    const s = useFiles.getState();
    s.load('repo-a', 'other.txt', source);
    s.load('repo-a', 'file.txt', source);
    s.edit(key, 'edits');
    s.load('repo-a', 'file.txt', { ...source, text: 'disk', revision: 'v2' }, true);
    expect(isDirty(useFiles.getState().buffers[key])).toBe(false);
    s.select('repo-a', 'file.txt');
    s.close(key);
    expect(useFiles.getState().selected['repo-a']).toBe('other.txt');
  });
});
