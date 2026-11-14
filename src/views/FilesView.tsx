import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, File, Folder, FolderOpen, RefreshCw, Save, X, ExternalLink, FilePlus, FolderPlus, Pencil, Trash2 } from 'lucide-react';
import type { FileEntry } from '../api/types';
import { useContextMenu, type MenuItem } from '../components/ui';
import { containsPath, joinPath, parentPath, validFileName } from '../lib/filePaths';
import { api } from '../api';
import { invalidateRepo, queryClient, reportError } from '../api/queries';
import { useApp } from '../stores/appStore';
import { fileKey, isDirty, useFiles } from '../stores/fileStore';
import { CodeEditor, forgetEditor } from '../components/CodeEditor';
import { SplitView } from '../components/SplitView';
import { errorMessage } from '../lib/errors';
import { bytes } from '../lib/format';

const documentKey = (repoId: string, path: string) => ['repo', repoId, 'file', path];

export async function saveBuffer(key: string) {
  const buffer = useFiles.getState().buffers[key];
  if (!buffer || buffer.saving || buffer.source.readOnly || !isDirty(buffer)) return false;
  useFiles.getState().saving(key, true);
  try {
    const source = await api.files.save(buffer.repoId, buffer.path, buffer.source.revision, buffer.text);
    useFiles.getState().saved(key, source);
    queryClient.setQueryData(documentKey(buffer.repoId, buffer.path), source);
    invalidateRepo(buffer.repoId);
    return true;
  } catch (e) {
    useFiles.getState().saving(key, false);
    reportError(e);
    return false;
  }
}

interface TreeProps {
  repoId: string; path: string; depth?: number; selected: string;
  expanded: Set<string>; toggle: (path: string) => void;
  onSelect: (entry: FileEntry) => void;
  onMenu: (event: MouseEvent, entry: FileEntry) => void;
}

function Directory({ repoId, path, depth = 0, selected, expanded, toggle, onSelect, onMenu }: TreeProps) {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ['repo', repoId, 'directory', path], queryFn: () => api.files.list(repoId, path) });
  if (q.isPending) return <div className="muted tree-message">{t('common.loading')}</div>;
  if (q.error) return <div className="error-text tree-message">{errorMessage(q.error)} <button onClick={() => void q.refetch()}>{t('files.retry')}</button></div>;
  return <>
    {q.data?.entries.map((entry) => {
      const open = expanded.has(entry.path);
      return <div key={entry.path} role="none">
        <button className={`file-tree-row ${selected === entry.path ? 'selected' : ''}`} style={{ paddingLeft: 8 + depth * 16 }}
          role="treeitem" aria-level={depth + 1} aria-expanded={entry.directory ? open : undefined} aria-selected={selected === entry.path}
          disabled={entry.symlink} title={entry.symlink ? t('files.symlink') : entry.path}
          onContextMenu={(event) => onMenu(event, entry)}
          onClick={() => { onSelect(entry); if (entry.directory) toggle(entry.path); else useFiles.getState().select(repoId, entry.path); }}>
          {entry.directory ? open ? <ChevronDown size={14} /> : <ChevronRight size={14} /> : <span className="tree-indent" />}
          {entry.directory ? open ? <FolderOpen size={15} /> : <Folder size={15} /> : <File size={15} />}
          <span>{entry.name}</span>
        </button>
        {entry.directory && open && <div role="group"><Directory repoId={repoId} path={entry.path} depth={depth + 1} selected={selected} expanded={expanded} toggle={toggle} onSelect={onSelect} onMenu={onMenu} /></div>}
      </div>;
    })}
    {q.data?.entries.length === 0 && <div className="muted tree-message">{t('files.emptyDirectory')}</div>}
    {q.data?.truncated && <div className="warn-text tree-message">{t('files.truncated')}</div>}
  </>;
}

export function FilesView({ repoId }: { repoId: string }) {
  const { t } = useTranslation();
  const menu = useContextMenu();
  const [target, setTarget] = useState<FileEntry | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const operation = useRef(false);
  const toggle = (path: string) => setExpanded((old) => { const next = new Set(old); if (next.has(path)) next.delete(path); else next.add(path); return next; });
  const runOperation = async (action: () => Promise<void>) => {
    if (operation.current) return;
    operation.current = true;
    setBusy(true);
    try { await action(); } catch (e) { reportError(e); }
    finally { operation.current = false; setBusy(false); }
  };
  const validate = (name: string) => validFileName(name) ? null : t('files.invalidName');
  const create = (directory: boolean, entry: FileEntry | null = target) => runOperation(async () => {
    const parent = entry ? entry.directory ? entry.path : parentPath(entry.path) : '';
    const name = await useApp.getState().prompt({ title: t(directory ? 'files.newFolder' : 'files.newFile'), label: t('files.nameIn', { path: parent || '/' }), validate });
    if (!name) return;
    const path = joinPath(parent, name);
    if (useFiles.getState().buffers[fileKey(repoId, path)]) throw { code: 'files.openDestination' };
    await api.files.create(repoId, path, directory);
    // Do not reuse cached data left by a file that was removed externally.
    queryClient.removeQueries({ queryKey: documentKey(repoId, path), exact: true });
    if (parent) setExpanded((old) => new Set([...old, parent]));
    setTarget({ name, path, directory, symlink: false });
    if (!directory) useFiles.getState().select(repoId, path);
    invalidateRepo(repoId);
  });
  const mutateEntry = (entry: FileEntry, rename: boolean) => runOperation(async () => {
    let newPath = '';
    if (rename) {
      const name = await useApp.getState().prompt({ title: t('files.rename'), label: t('files.name'), initial: entry.name, validate });
      if (!name || name === entry.name) return;
      newPath = joinPath(parentPath(entry.path), name);
      // Do not replace a stale but unsaved destination buffer either.
      if (Object.values(useFiles.getState().buffers).some((b) => b.repoId === repoId && containsPath(newPath, b.path))) {
        throw { code: 'files.openDestination' };
      }
    } else {
      const dirty = Object.values(useFiles.getState().buffers).filter((b) => b.repoId === repoId && containsPath(entry.path, b.path) && isDirty(b));
      if (!await useApp.getState().ask({ title: t('files.delete'), body: t(entry.directory ? 'files.deleteFolderBody' : 'files.deleteBody', { path: entry.path }),
        note: dirty.length ? t('files.deleteUnsaved') : undefined, danger: true, confirmLabel: t('files.delete') })) return;
    }
    const affected = Object.entries(useFiles.getState().buffers).filter(([, b]) => b.repoId === repoId && containsPath(entry.path, b.path));
    if (affected.some(([, b]) => b.saving)) throw { code: 'files.saving' };
    affected.forEach(([key]) => useFiles.getState().saving(key, true));
    try {
      if (rename) await api.files.rename(repoId, entry.path, newPath);
      else await api.files.delete(repoId, entry.path);
      await queryClient.cancelQueries({ queryKey: ['repo', repoId, 'file'] });
      affected.forEach(([key]) => forgetEditor(key));
      queryClient.removeQueries({ queryKey: ['repo', repoId, 'file'] });
      if (rename) {
        useFiles.getState().renamePath(repoId, entry.path, newPath);
        // The identity changed, so release the mutation guard on the new keys.
        affected.forEach(([, b]) => useFiles.getState().saving(fileKey(repoId, newPath + b.path.slice(entry.path.length)), false));
        setTarget({ ...entry, name: newPath.split('/').pop()!, path: newPath });
        setExpanded((old) => new Set([...old].map((path) => containsPath(entry.path, path) ? newPath + path.slice(entry.path.length) : path)));
      } else {
        useFiles.getState().removePath(repoId, entry.path);
        setTarget(null);
        setExpanded((old) => new Set([...old].filter((path) => !containsPath(entry.path, path))));
      }
      invalidateRepo(repoId);
    } finally { affected.forEach(([key]) => useFiles.getState().saving(key, false)); }
  });
  const menuItems = (entry: FileEntry | null): MenuItem[] => [
    { label: t('files.newFile'), disabled: busy || entry?.symlink, onClick: () => void create(false, entry) },
    { label: t('files.newFolder'), disabled: busy || entry?.symlink, onClick: () => void create(true, entry) },
    ...(entry ? [
      { separator: true },
      { label: t('files.rename'), disabled: busy || entry.symlink, onClick: () => void mutateEntry(entry, true) },
      { label: t('files.delete'), disabled: busy || entry.symlink, danger: true, onClick: () => void mutateEntry(entry, false) },
    ] : []),
  ];
  const buffers = useFiles((s) => s.buffers);
  const path = useFiles((s) => s.selected[repoId] ?? '');
  const key = fileKey(repoId, path);
  const buffer = buffers[key];
  const q = useQuery({ queryKey: documentKey(repoId, path), queryFn: () => api.files.read(repoId, path), enabled: !!path });
  useEffect(() => {
    if (q.data && path) useFiles.getState().load(repoId, path, q.data);
  }, [repoId, path, q.data]);
  const openBuffers = Object.entries(buffers).filter(([, b]) => b.repoId === repoId);
  const dirty = buffer && isDirty(buffer);
  const changed = buffer && q.data && q.data.revision !== buffer.source.revision;
  const reload = async () => {
    if (dirty && !await useApp.getState().ask({ title: t('files.reload'), body: t('files.discardBody'), danger: true, confirmLabel: t('files.discard') })) return;
    const result = await q.refetch();
    if (result.data) { forgetEditor(key); useFiles.getState().load(repoId, path, result.data, true); }
  };
  const close = async (closingKey: string) => {
    const b = useFiles.getState().buffers[closingKey];
    if (!b || b.saving) return;
    if (isDirty(b)) {
      const choice = await useApp.getState().choose({ title: t('files.unsaved'), body: b.path, confirmLabel: t('files.save'), altLabel: t('files.discard'), altDanger: true });
      if (choice === 'cancel') return;
      if (choice === 'confirm' && (!await saveBuffer(closingKey) || isDirty(useFiles.getState().buffers[closingKey]))) return;
    }
    forgetEditor(closingKey);
    useFiles.getState().close(closingKey);
  };
  return <><SplitView id="files" className="files-view" initialSizes={[25, 75]} minSizes={[180, 260]}>
    <section className="file-tree-panel">
      <div className="file-toolbar file-tree-toolbar"><strong>{t('files.title')}</strong><span className="spacer" />
        <button className="icon-btn" title={t('files.newFile')} aria-label={t('files.newFile')} disabled={busy} onClick={() => void create(false)}><FilePlus size={16} /></button>
        <button className="icon-btn" title={t('files.newFolder')} aria-label={t('files.newFolder')} disabled={busy} onClick={() => void create(true)}><FolderPlus size={16} /></button>
        <button className="icon-btn" title={t('files.rename')} aria-label={t('files.rename')} disabled={busy || !target || target.symlink} onClick={() => target && void mutateEntry(target, true)}><Pencil size={16} /></button>
        <button className="icon-btn" title={t('files.delete')} aria-label={t('files.delete')} disabled={busy || !target || target.symlink} onClick={() => target && void mutateEntry(target, false)}><Trash2 size={16} /></button>
        <button className="icon-btn" title={t('files.refresh')} aria-label={t('files.refresh')} onClick={() => invalidateRepo(repoId)}><RefreshCw size={16} /></button>
      </div>
      <div className="file-tree" role="tree" aria-label={t('files.title')}
        onClick={(event) => { if (event.target === event.currentTarget) setTarget(null); }}
        onContextMenu={(event) => menu.open(event, menuItems(null))}>
        <Directory repoId={repoId} path="" selected={target?.path ?? ''} expanded={expanded} toggle={toggle} onSelect={setTarget}
          onMenu={(event, entry) => { event.stopPropagation(); setTarget(entry); menu.open(event, menuItems(entry)); }} />
      </div>
    </section>
    <section className="file-editor-panel">
      {openBuffers.length > 0 && <div className="file-tabs" role="tablist" aria-label={t('files.openFiles')}>
        {openBuffers.map(([id, b]) => <div className={`file-tab ${b.path === path ? 'active' : ''}`} key={id}>
          <button role="tab" aria-selected={b.path === path} title={b.path} onClick={() => { useFiles.getState().select(repoId, b.path); setTarget({ name: b.path.split('/').pop()!, path: b.path, directory: false, symlink: false }); }}>{b.path.split('/').pop()}{isDirty(b) ? ' *' : ''}</button>
          <button className="icon-btn" title={t('files.close')} aria-label={`${t('files.close')} ${b.path}`} disabled={b.saving} onClick={() => void close(id)}><X size={13} /></button>
        </div>)}
      </div>}
      {!path ? <div className="diff-empty muted">{t('files.select')}</div> : <>
        <div className="file-toolbar">
          <span className="file-path mono" title={path}>{path}{dirty ? ' *' : ''}</span><span className="spacer" />
          {buffer && <span className="muted small-text">{buffer.source.text !== null && <>{buffer.source.bom ? 'UTF-8 BOM' : 'UTF-8'} · {buffer.source.eol} · </>}{bytes(buffer.source.size)}</span>}
          <button className="icon-btn" title={t('files.reload')} aria-label={t('files.reload')} disabled={buffer?.saving} onClick={() => void reload()}><RefreshCw size={16} /></button>
          <button className="icon-btn" title={t('files.external')} aria-label={t('files.external')} onClick={() => void api.external.open(repoId, path, 'editor').catch(reportError)}><ExternalLink size={16} /></button>
          <button className="icon-btn" title={t('files.save')} aria-label={t('files.save')} disabled={!dirty || buffer?.saving || !!buffer?.source.readOnly} onClick={() => void saveBuffer(key)}><Save size={16} /></button>
        </div>
        {q.isPending && !buffer && <p className="muted pad">{t('common.loading')}</p>}
        {q.error && <div className="banner banner-warn">{errorMessage(q.error)}</div>}
        {changed && dirty && <div className="banner banner-warn">{t('files.diskChanged')}</div>}
        {buffer?.source.readOnly && <div className="diff-notice">{t(`files.readOnly.${buffer.source.readOnly}`)}</div>}
        {buffer && buffer.source.text !== null && <CodeEditor key={key} id={key} path={path} text={buffer.text} readOnly={!!buffer.source.readOnly}
          onChange={(text) => useFiles.getState().edit(key, text)} onSave={() => void saveBuffer(key)} />}
      </>}
    </section>
  </SplitView>{menu.element}</>;
}
