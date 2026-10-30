import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, File, Folder, FolderOpen, RefreshCw, Save, X, ExternalLink } from 'lucide-react';
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

function Directory({ repoId, path, depth = 0 }: { repoId: string; path: string; depth?: number }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const selected = useFiles((s) => s.selected[repoId]);
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
          onClick={() => entry.directory ? setExpanded((old) => { const next = new Set(old); if (open) next.delete(entry.path); else next.add(entry.path); return next; }) : useFiles.getState().select(repoId, entry.path)}>
          {entry.directory ? open ? <ChevronDown size={14} /> : <ChevronRight size={14} /> : <span className="tree-indent" />}
          {entry.directory ? open ? <FolderOpen size={15} /> : <Folder size={15} /> : <File size={15} />}
          <span>{entry.name}</span>
        </button>
        {entry.directory && open && <div role="group"><Directory repoId={repoId} path={entry.path} depth={depth + 1} /></div>}
      </div>;
    })}
    {q.data?.entries.length === 0 && <div className="muted tree-message">{t('files.emptyDirectory')}</div>}
    {q.data?.truncated && <div className="warn-text tree-message">{t('files.truncated')}</div>}
  </>;
}

export function FilesView({ repoId }: { repoId: string }) {
  const { t } = useTranslation();
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
  return <SplitView id="files" className="files-view" initialSizes={[25, 75]} minSizes={[160, 260]}>
    <section className="file-tree-panel">
      <div className="file-toolbar"><strong>{t('files.title')}</strong><span className="spacer" />
        <button className="icon-btn" title={t('files.refresh')} aria-label={t('files.refresh')} onClick={() => invalidateRepo(repoId)}><RefreshCw size={16} /></button>
      </div>
      <div className="file-tree" role="tree" aria-label={t('files.title')}><Directory key={repoId} repoId={repoId} path="" /></div>
    </section>
    <section className="file-editor-panel">
      {openBuffers.length > 0 && <div className="file-tabs" role="tablist" aria-label={t('files.openFiles')}>
        {openBuffers.map(([id, b]) => <div className={`file-tab ${b.path === path ? 'active' : ''}`} key={id}>
          <button role="tab" aria-selected={b.path === path} title={b.path} onClick={() => useFiles.getState().select(repoId, b.path)}>{b.path.split('/').pop()}{isDirty(b) ? ' *' : ''}</button>
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
  </SplitView>;
}
