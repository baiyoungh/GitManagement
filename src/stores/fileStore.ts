import { create } from 'zustand';
import type { FileDocument } from '../api';

export interface Buffer {
  repoId: string;
  path: string;
  source: FileDocument;
  text: string;
  saving: boolean;
}

export const fileKey = (repoId: string, path: string) => JSON.stringify([repoId, path]);
export const isDirty = (buffer: Buffer) => buffer.text !== (buffer.source.text ?? '');

interface FilesState {
  buffers: Record<string, Buffer>;
  selected: Record<string, string>;
  select: (repoId: string, path: string) => void;
  load: (repoId: string, path: string, source: FileDocument, force?: boolean) => void;
  edit: (key: string, text: string) => void;
  saving: (key: string, saving: boolean) => void;
  saved: (key: string, source: FileDocument) => void;
  close: (key: string) => void;
}

export const useFiles = create<FilesState>((set) => ({
  buffers: {}, selected: {},
  select: (repoId, path) => set((s) => ({ selected: { ...s.selected, [repoId]: path } })),
  load: (repoId, path, source, force = false) => set((s) => {
    const key = fileKey(repoId, path);
    const old = s.buffers[key];
    if (old && (old.saving || (!force && isDirty(old)))) return s;
    return { buffers: { ...s.buffers, [key]: { repoId, path, source, text: source.text ?? '', saving: false } } };
  }),
  edit: (key, text) => set((s) => s.buffers[key] ? ({ buffers: { ...s.buffers, [key]: { ...s.buffers[key], text } } }) : s),
  saving: (key, saving) => set((s) => s.buffers[key] ? ({ buffers: { ...s.buffers, [key]: { ...s.buffers[key], saving } } }) : s),
  saved: (key, source) => set((s) => s.buffers[key] ? ({ buffers: { ...s.buffers, [key]: { ...s.buffers[key], source, saving: false } } }) : s),
  close: (key) => set((s) => {
    const buffers = { ...s.buffers };
    const buffer = buffers[key];
    delete buffers[key];
    const selected = { ...s.selected };
    if (buffer && selected[buffer.repoId] === buffer.path) {
      const remaining = Object.values(buffers).filter((b) => b.repoId === buffer.repoId);
      selected[buffer.repoId] = remaining[remaining.length - 1]?.path ?? '';
    }
    return { buffers, selected };
  }),
}));
