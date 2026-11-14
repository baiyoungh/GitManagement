// 三栏合并窗口（specs/05 第 2.2 节；X-03、X-04）
// 左：我方（Ours）  中：结果（可编辑）  右：对方（Theirs）
import { useEffect, useMemo, useRef, useState } from 'react';
import { SplitView } from '../components/SplitView';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../api';
import { invalidateRepo, reportError } from '../api/queries';
import { useApp } from '../stores/appStore';
import { useAuth } from '../stores/authStore';
import { errorMessage } from '../lib/errors';
import { Icon } from '../components/Icon';
import {
  acceptAll,
  applyNonConflicting,
  applySide,
  buildResult,
  counts,
  createModel,
  ignoreBlock,
  isChange,
  joinLines,
  type MergeModel,
} from '../lib/mergeModel';

const LINE_H = 20;

function Pane({ lines, blocks, rangeOf, kindOf, current, onRef, side, children }: {
  lines: string[];
  blocks: { kind: string }[];
  rangeOf: (i: number) => { start: number; end: number };
  kindOf: (i: number) => string;
  current: number;
  onRef: (el: HTMLDivElement | null) => void;
  side: 'ours' | 'theirs';
  children?: (i: number) => React.ReactNode;
}) {
  return (
    <div className={`merge-pane mono pane-${side}`} ref={onRef}>
      {blocks.map((_, i) => {
        const r = rangeOf(i);
        const cls = kindOf(i);
        const n = Math.max(1, r.end - r.start);
        return (
          <div key={i} className={`mblock ${cls} ${i === current ? 'current' : ''}`} data-block={i}>
            {children && <div className="mblock-actions">{children(i)}</div>}
            {r.end === r.start ? (
              cls !== 'unchanged' ? <div className="mline empty" style={{ height: LINE_H }} /> : null
            ) : (
              lines.slice(r.start, r.end).map((l, k) => (
                <div key={k} className="mline">
                  <span className="ln">{r.start + k + 1}</span>
                  <span className="mtext">{l || ' '}</span>
                </div>
              ))
            )}
            {n === 0 && null}
          </div>
        );
      })}
    </div>
  );
}

export function MergeWindow({ repoId, path, oursLabel, theirsLabel, onClose }: { repoId: string; path: string; oursLabel: string; theirsLabel: string; onClose: () => void }) {
  const { t } = useTranslation();
  const ask = useApp((s) => s.ask);
  const toast = useApp((s) => s.toast);
  const q = useQuery({ queryKey: ['repo', repoId, 'mergeData', path], queryFn: () => api.conflict.load(repoId, path), staleTime: Infinity, gcTime: 0 });
  const [model, setModel] = useState<MergeModel | null>(null);
  /** 用户手动编辑过结果后，以编辑文本为准 */
  const [edited, setEdited] = useState<string | null>(null);
  const [current, setCurrent] = useState(0);
  const [showBase, setShowBase] = useState(false);
  const [busy, setBusy] = useState(false);
  const panes = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    if (q.data) setModel(createModel(q.data));
  }, [q.data]);

  const result = useMemo(() => (model ? buildResult(model) : { lines: [], starts: [] }), [model]);
  const resultText = edited ?? (q.data ? joinLines(result.lines, q.data.eol, (q.data.ours ?? q.data.theirs ?? '').endsWith('\n')) : '');
  const c = model ? counts(model) : { conflicts: 0, changes: 0 };
  const changeIdx = model ? model.blocks.map((b, i) => (isChange(b) && !model.states[i].resolved ? i : -1)).filter((i) => i >= 0) : [];
  const conflictIdx = model ? model.blocks.map((b, i) => (b.kind === 'conflict' && !model.states[i].resolved ? i : -1)).filter((i) => i >= 0) : [];

  // 同步滚动三栏（按比例）
  const syncing = useRef(false);
  const onScroll = (from: number) => () => {
    if (syncing.current) return;
    const src = panes.current[from];
    if (!src) return;
    syncing.current = true;
    const ratio = src.scrollTop / Math.max(1, src.scrollHeight - src.clientHeight);
    panes.current.forEach((p, i) => {
      if (p && i !== from) p.scrollTop = ratio * (p.scrollHeight - p.clientHeight);
    });
    requestAnimationFrame(() => (syncing.current = false));
  };
  useEffect(() => {
    const handlers = panes.current.map((p, i) => {
      const h = onScroll(i);
      p?.addEventListener('scroll', h);
      return () => p?.removeEventListener('scroll', h);
    });
    return () => handlers.forEach((u) => u());
  });

  const goTo = (i: number) => {
    setCurrent(i);
    panes.current.forEach((p) => p?.querySelector(`[data-block="${i}"]`)?.scrollIntoView({ block: 'center' }));
  };
  const nav = (delta: number) => {
    const list = conflictIdx.length ? conflictIdx : changeIdx;
    if (!list.length) return;
    const pos = list.findIndex((i) => i >= current + (delta > 0 ? 1 : 0));
    const next = delta > 0 ? list[pos === -1 ? 0 : pos] : list[(pos === -1 ? list.length : pos) - 1] ?? list[list.length - 1];
    goTo(next);
  };

  const mutate = (fn: (m: MergeModel) => MergeModel) => {
    if (!model) return;
    if (edited !== null) {
      // 已手动编辑：块操作会覆盖手动修改，先确认
      void ask({ title: t('merge.discardEditsTitle'), body: t('merge.discardEditsBody'), confirmLabel: t('common.confirm') }).then((ok) => {
        if (ok) {
          setEdited(null);
          setModel(fn(model));
        }
      });
      return;
    }
    setModel(fn(model));
  };

  const apply = async () => {
    if (!q.data) return;
    const unresolved = edited === null ? c.conflicts + c.changes : 0;
    const hasMarkers = /^(<{7}|>{7}|={7})( |$)/m.test(resultText);
    if (unresolved > 0 || hasMarkers) {
      const ok = await ask({
        title: t('merge.unresolvedTitle'),
        body: hasMarkers ? t('merge.markersBody') : t('merge.unresolvedBody', { conflicts: c.conflicts, changes: c.changes }),
        confirmLabel: t('merge.applyAnyway'),
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      await api.conflict.resolve(repoId, path, resultText);
      toast('success', t('merge.resolved', { path }));
      invalidateRepo(repoId);
      onClose();
    } catch (e) {
      reportError(e);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (Object.keys(useAuth.getState().challenges).length) return;
      if (e.key === 'F7') {
        e.preventDefault();
        nav(e.shiftKey ? -1 : 1);
      } else if (e.key === 'Escape' && !useApp.getState().confirm) {
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const kindClass = (i: number) => {
    if (!model) return '';
    const b = model.blocks[i];
    const s = model.states[i];
    if (b.kind === 'unchanged') return 'unchanged';
    return `${b.kind} ${s.resolved ? 'resolved' : ''}`;
  };

  const sideButtons = (side: 'ours' | 'theirs') => (i: number) => {
    if (!model) return null;
    const b = model.blocks[i];
    const s = model.states[i];
    if (b.kind === 'unchanged' || s.resolved) return null;
    const relevant = b.kind === 'conflict' || b.kind === 'both' || b.kind === side;
    if (!relevant) return null;
    if (s[side]) return <span className="muted"><Icon name="check" size={14} /></span>;
    const arrow = <Icon name={side === 'ours' ? 'chevronsRight' : 'chevronsLeft'} size={14} />;
    const label = side === 'ours' ? t('merge.applyLeft') : t('merge.applyRight');
    return (
      <>
        {side === 'theirs' && (
          <button className="gutter-btn" title={label} aria-label={label} onClick={() => mutate((m) => applySide(m, i, side))}>
            {arrow}
          </button>
        )}
        <button className="gutter-btn ignore" title={t('merge.ignore')} aria-label={t('merge.ignore')} onClick={() => mutate((m) => ignoreBlock(m, i))}>
          <Icon name="close" size={12} />
        </button>
        {side === 'ours' && (
          <button className="gutter-btn" title={label} aria-label={label} onClick={() => mutate((m) => applySide(m, i, side))}>
            {arrow}
          </button>
        )}
      </>
    );
  };

  return createPortal(
    <div className="merge-window" role="dialog" aria-modal="true" aria-label={t('merge.title', { path })}>
      <div className="modal-header">
        <h2>{t('merge.title', { path })}</h2>
        <button className="icon-btn" onClick={onClose} aria-label={t('common.close')}>
          <Icon name="close" />
        </button>
      </div>
      <div className="diff-toolbar">
        <button onClick={() => mutate(applyNonConflicting)} disabled={!model || c.changes === 0}>
          <Icon name="zap" size={14} /> {t('merge.applyNonConflicting')}
        </button>
        <button onClick={() => mutate((m) => acceptAll(m, 'ours'))} disabled={!model}>
          {t('merge.acceptLeft')}
        </button>
        <button onClick={() => mutate((m) => acceptAll(m, 'theirs'))} disabled={!model}>
          {t('merge.acceptRight')}
        </button>
        <label className="check">
          <input type="checkbox" checked={showBase} onChange={(e) => setShowBase(e.target.checked)} />
          {t('merge.showBase')}
        </label>
        <span className="spacer" />
        <button className="icon-btn" onClick={() => nav(-1)} title={t('diff.prev')} aria-label={t('diff.prev')}>
          <Icon name="arrowUp" />
        </button>
        <button className="icon-btn" onClick={() => nav(1)} title={t('diff.next')} aria-label={t('diff.next')}>
          <Icon name="arrowDown" />
        </button>
      </div>
      {q.isError && <p className="error-text pad">{errorMessage(q.error)}</p>}
      {q.data?.worktreeEdited && <div className="diff-notice warn-text">{t('merge.worktreeEdited')}</div>}
      {model && q.data && (
        <SplitView key={String(showBase)} id={showBase ? 'merge-with-base' : 'merge'} className="merge-body" minSizes={showBase ? [140, 140, 140, 140] : [140, 140, 140]}>
          <div className="merge-col">
            <div className="merge-col-title">
              {t('conflicts.ours')} · {oursLabel}
            </div>
            <Pane
              side="ours"
              lines={model.ours}
              blocks={model.blocks}
              rangeOf={(i) => model.blocks[i].ours}
              kindOf={kindClass}
              current={current}
              onRef={(el) => (panes.current[0] = el)}
              children={sideButtons('ours')}
            />
          </div>
          {showBase && (
            <div className="merge-col">
              <div className="merge-col-title">Base</div>
              <Pane side="ours" lines={model.base} blocks={model.blocks} rangeOf={(i) => model.blocks[i].base} kindOf={kindClass} current={current} onRef={(el) => (panes.current[3] = el)} />
            </div>
          )}
          <div className="merge-col result">
            <div className="merge-col-title">
              {t('merge.result')} {edited !== null && <span className="tag">{t('merge.editedManually')}</span>}
            </div>
            {edited === null ? (
              <div className="merge-pane mono" ref={(el) => (panes.current[1] = el)} onDoubleClick={() => setEdited(resultText)} title={t('merge.dblClickEdit')}>
                {model.blocks.map((b, i) => {
                  const start = result.starts[i];
                  const end = i + 1 < result.starts.length ? result.starts[i + 1] : result.lines.length;
                  const unresolvedConflict = b.kind === 'conflict' && !model.states[i].resolved && !model.states[i].ours && !model.states[i].theirs;
                  return (
                    <div key={i} className={`mblock ${kindClass(i)} ${i === current ? 'current' : ''}`} data-block={i} onClick={() => isChange(b) && setCurrent(i)}>
                      {unresolvedConflict && <div className="mline conflict-marker">{t('merge.unresolvedMarker')}</div>}
                      {result.lines.slice(start, end).map((l, k) => (
                        <div key={k} className="mline">
                          <span className="ln">{start + k + 1}</span>
                          <span className="mtext">{l || ' '}</span>
                        </div>
                      ))}
                    </div>
                  );
                })}
              </div>
            ) : (
              <textarea
                className="merge-editor mono"
                value={edited}
                onChange={(e) => setEdited(e.target.value)}
                spellCheck={false}
                aria-label={t('merge.result')}
                ref={(el) => (panes.current[1] = el as unknown as HTMLDivElement)}
              />
            )}
          </div>
          <div className="merge-col">
            <div className="merge-col-title">
              {t('conflicts.theirs')} · {theirsLabel}
            </div>
            <Pane
              side="theirs"
              lines={model.theirs}
              blocks={model.blocks}
              rangeOf={(i) => model.blocks[i].theirs}
              kindOf={kindClass}
              current={current}
              onRef={(el) => (panes.current[2] = el)}
              children={sideButtons('theirs')}
            />
          </div>
        </SplitView>
      )}
      <div className="modal-footer">
        <span className={c.conflicts > 0 ? 'warn-text' : 'muted'}>
          {edited !== null ? t('merge.editedHint') : t('merge.remaining', { conflicts: c.conflicts, changes: c.changes })}
        </span>
        <span className="spacer" />
        {edited !== null && <button onClick={() => setEdited(null)}>{t('merge.discardEdits')}</button>}
        <button onClick={onClose}>{t('common.cancel')}</button>
        <button className="primary" disabled={!q.data || busy} onClick={apply}>
          {t('merge.apply')}
        </button>
      </div>
    </div>,
    document.body,
  );
}
