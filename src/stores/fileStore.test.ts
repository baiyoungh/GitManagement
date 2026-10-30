import { beforeEach, describe, expect, it } from 'vitest';
import { fileKey, isDirty, useFiles } from './fileStore';
import type { FileDocument } from '../api';

const source: FileDocument = { text: 'original\n', revision: 'v1', size: 9, eol: 'LF', bom: false, readOnly: null };
const key = fileKey('repo-a', 'file.txt');
beforeEach(() => useFiles.setState({ buffers: {}, selected: {} }));

describe('file editing buffers', () => {
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
