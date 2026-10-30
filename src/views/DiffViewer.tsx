// 差异查看器（specs/05 第 1 节；D-01 并排、D-02 统一、D-03 选项、D-04 语法高亮）
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { api } from '../api';
import type { DiffOpts, FileChange, FileDiff, Hunk, Rev } from '../api/types';
import { invalidateRepo, reportError } from '../api/queries';
import { useApp } from '../stores/appStore';
import { buildSideBySide, buildUnified, inlineRange, revertHunk, type Row, type UnifiedRow } from '../lib/diffModel';
import { highlightLines, type Token } from '../lib/highlight';
import { Icon } from '../components/Icon';
import { bytes } from '../lib/format';
import { errorMessage } from '../lib/errors';
import { hunkKeys, hunkState, lineIncluded, toggleHunk, toggleLine } from '../lib/partialModel';
import { usePartial, partialKey } from '../stores/partialStore';
import { ImageDiff, isImagePath } from './ImageDiff';
import { widestLine } from '../lib/diffWidth';

const ROW_H = 20;

export interface DiffTarget {
  repoId: string;
  file: FileChange;
  left: Rev;
  right: Rev;
  /** 允许在差异中勾选 hunk / 行做部分提交（C-03） */
  selectable?: boolean;
  /** 允许切换左侧比较对象（D-06：工作区 vs 暂存区 / HEAD / 任意提交或分支） */
  switchableLeft?: boolean;
}

function useDiffPrefs() {
  const settings = useApp((s) => s.settings);
  const patch = useApp((s) => s.patchSetting);
  const set = (k: string, v: string) => {
    patch(k, v);
    void api.settings.set(k, v);
  };
  return {
    mode: (settings['diff.mode'] ?? 'side') as 'side' | 'unified',
    whitespace: (settings['diff.whitespace'] ?? 'none') as DiffOpts['whitespace'],
    ignoreCr: settings['diff.ignoreCr'] === 'true',
    collapse: settings['diff.collapse'] !== 'false',
    algorithm: (settings['diff.algorithm'] ?? 'myers') as DiffOpts['algorithm'],
    set,
  };
}

function revLabel(t: TFunction, rev: Rev) {
  return rev.kind === 'worktree' ? t('diff.worktree') : rev.kind === 'index' ? t('diff.index') : rev.rev === 'HEAD' ? t('diff.head') : rev.rev.slice(0, 10);
}

function Highlighted({ text, tokens, inline }: { text: string; tokens?: Token[]; inline?: [number, number] }) {
  // 将语法 token 与行内改动区间合并渲染
  const marks = new Set<number>();
  if (tokens) for (const tk of tokens) marks.add(tk.from).add(tk.to);
  if (inline) marks.add(inline[0]).add(inline[1]);
  marks.add(0).add(text.length);
  const cuts = [...marks].filter((m) => m >= 0 && m <= text.length).sort((a, b) => a - b);
  const parts: ReactNode[] = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const from = cuts[i];
    const to = cuts[i + 1];
    if (to <= from) continue;
    const tk = tokens?.find((x) => x.from <= from && x.to >= to);
    const changed = inline && from >= inline[0] && to <= inline[1];
    const cls = [tk?.cls, changed ? 'inline-change' : ''].filter(Boolean).join(' ');
    parts.push(
      <span key={from} className={cls || undefined}>
        {text.slice(from, to)}
      </span>,
    );
  }
  return <>{parts.length ? parts : text || ' '}</>;
}

export function DiffViewer({ target: rawTarget }: { target: DiffTarget | null }) {
  const { t } = useTranslation();
  const prefs = useDiffPrefs();
  const prompt = useApp((s) => s.prompt);
  // D-06：左侧比较对象可临时切换，切换文件后恢复默认
  const [leftOverride, setLeftOverride] = useState<Rev | null>(null);
  useEffect(() => setLeftOverride(null), [rawTarget?.file.path, rawTarget?.repoId]);
  const target: DiffTarget | null = rawTarget && leftOverride ? { ...rawTarget, left: leftOverride, selectable: false } : rawTarget;
  const [force, setForce] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [current, setCurrent] = useState(0);
  const ask = useApp((s) => s.ask);

  useEffect(() => {
    setForce(false);
    setExpanded(new Set());
    setCurrent(0);
  }, [target?.file.path, target?.repoId]);

  const opts: DiffOpts = { whitespace: prefs.whitespace, ignoreCrAtEol: prefs.ignoreCr, algorithm: prefs.algorithm, force };
  const q = useQuery({
    queryKey: ['repo', target?.repoId ?? '', 'diff', target?.file.path, target?.file.origPath, target?.left, target?.right, opts],
    queryFn: () => api.diff.file(target!.repoId, target!.file.path, target!.file.origPath, target!.left, target!.right, opts),
    enabled: !!target,
  });
  const diff = q.data;

  const hl = useQuery({
    queryKey: ['highlight', target?.file.path, diff?.old.text, diff?.new.text],
    queryFn: async () => ({
      old: await highlightLines(target!.file.path, diff!.old.text),
      new: await highlightLines(target!.file.path, diff!.new.text),
    }),
    enabled: !!diff && !diff.binary && !diff.tooLarge,
    staleTime: Infinity,
  });

  const collapse = prefs.collapse;
  const sideRows = useMemo(() => (diff ? expandRows(buildSideBySide(diff.old.text, diff.new.text, diff.hunks, collapse), expanded, diff) : []), [diff, collapse, expanded]);
  const uniRows = useMemo(() => (diff ? expandUnified(buildUnified(diff.old.text, diff.new.text, diff.hunks, collapse), expanded, diff) : []), [diff, collapse, expanded]);
  const rows: (Row | UnifiedRow)[] = prefs.mode === 'side' ? sideRows : uniRows;

  const parentRef = useRef<HTMLDivElement>(null);
  const horizontalRef = useRef<HTMLDivElement>(null);
  const settings = useApp((s) => s.settings);
  const [lineWidth, setLineWidth] = useState(0);
  const [viewportWidth, setViewportWidth] = useState(0);
  useLayoutEffect(() => {
    const element = parentRef.current;
    if (!element) return;
    const measure = () => {
      const context = document.createElement('canvas').getContext('2d');
      if (!context) return;
      const style = getComputedStyle(element);
      context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const textWidth = (text: string) => context.measureText(text).width;
      const tab = Math.max(1, textWidth(' ') * 8);
      setLineWidth(Math.max(widestLine(diff?.old.text, textWidth, tab), widestLine(diff?.new.text, textWidth, tab)));
    };
    measure();
    const resize = new ResizeObserver(() => setViewportWidth(element.clientWidth));
    resize.observe(element);
    setViewportWidth(element.clientWidth);
    let disposed = false;
    void document.fonts?.ready.then(() => { if (!disposed) measure(); });
    return () => { disposed = true; resize.disconnect(); };
  }, [diff, prefs.mode, settings['code.font'], settings['code.fontSize']]);
  useEffect(() => {
    const element = parentRef.current;
    if (!element) return;
    element.scrollLeft = 0;
    element.style.setProperty('--diff-offset', '0px');
    if (horizontalRef.current) horizontalRef.current.scrollLeft = 0;
    const wheel = (event: WheelEvent) => {
      const bar = horizontalRef.current;
      const delta = event.deltaX || (event.shiftKey ? event.deltaY : 0);
      if (prefs.mode === 'side' && bar && delta) {
        event.preventDefault();
        bar.scrollLeft += delta * (event.deltaMode === 1 ? ROW_H : event.deltaMode === 2 ? bar.clientWidth : 1);
      }
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [target?.repoId, target?.file.path, prefs.mode, diff]);
  const virt = useVirtualizer({ count: rows.length, getScrollElement: () => parentRef.current, estimateSize: () => ROW_H, overscan: 30 });

  const hunkFirstRow = useMemo(() => {
    const m: number[] = [];
    rows.forEach((r, i) => {
      const h = r.kind === 'line' ? ('hunk' in r ? r.hunk : r.line.hunk) : null;
      if (h !== null && m[h] === undefined) m[h] = i;
    });
    return m;
  }, [rows]);

  const go = (delta: number) => {
    if (!diff || diff.hunks.length === 0) return;
    const next = (current + delta + diff.hunks.length) % diff.hunks.length;
    setCurrent(next);
    const row = hunkFirstRow[next];
    if (row !== undefined) virt.scrollToIndex(row, { align: 'center' });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement | null)?.closest('.terminal-host')) return;
      if (e.key === 'F7') {
        e.preventDefault();
        go(e.shiftKey ? -1 : 1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const canRevert = target?.right.kind === 'worktree' && target.left.kind === 'commit' && diff?.new.exists && diff.old.exists;

  // ---------- 部分提交（C-03） ----------
  // 忽略空白时 hunk 不覆盖全部改动，部分提交会丢失空白改动，因此要求关闭这些选项
  const wsFiltered = prefs.whitespace !== 'none' || prefs.ignoreCr;
  const selectable = !!target?.selectable && !!diff && !diff.binary && !diff.tooLarge && diff.hunks.length > 0 && !wsFiltered;
  const pkey = target ? partialKey(target.repoId, target.file.path) : '';
  const sel = usePartial((s) => s.sel[pkey]);
  const setSel = usePartial((s) => s.set);
  const syncSel = usePartial((s) => s.sync);
  const keys = useMemo(() => (diff && !diff.binary && !diff.tooLarge ? hunkKeys(diff.old.text, diff.new.text, diff.hunks) : []), [diff]);
  useEffect(() => {
    if (target?.selectable && diff && !wsFiltered) syncSel(target.repoId, target.file.path, diff.hunks, keys);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys, wsFiltered]);
  const onToggleHunk = (i: number) => target && diff && setSel(target.repoId, target.file.path, toggleHunk(sel, diff.hunks, keys, i));
  const onToggleLine = (i: number, side: 'o' | 'n', no: number) =>
    target && diff && setSel(target.repoId, target.file.path, toggleLine(sel, diff.hunks, keys, i, side, no));
  const excluded = (hunkIdx: number | null, side: 'o' | 'n', no: number | null) =>
    selectable && hunkIdx !== null && no !== null && !lineIncluded(sel, hunkIdx, side, no);
  const selLn = (no: number | null, side: 'o' | 'n', hunkIdx: number | null, type: string) => {
    if (!selectable || no === null || hunkIdx === null || type === 'context' || type === 'empty' || !diff) return null;
    const on = lineIncluded(sel, hunkIdx, side, no);
    return (
      <button
        className={`ln ln-sel ${on ? 'on' : 'off'}`}
        title={t('diff.toggleLine')}
        aria-label={`${t('diff.toggleLine')} ${no}`}
        aria-pressed={on}
        onClick={() => onToggleLine(hunkIdx, side, no)}
      >
        {on ? '✓' : ''} {no}
      </button>
    );
  };
  const hunkBox = (hunkIdx: number) => {
    if (!diff) return null;
    const st = hunkState(sel, hunkIdx);
    return (
      <input
        type="checkbox"
        className="hunk-check"
        checked={st === 'all'}
        ref={(el) => {
          if (el) el.indeterminate = st === 'partial';
        }}
        aria-label={t('diff.toggleHunk')}
        title={t('diff.toggleHunk')}
        onChange={() => onToggleHunk(hunkIdx)}
      />
    );
  };

  const leftValue = target ? (target.left.kind === 'commit' ? (target.left.rev === 'HEAD' ? 'HEAD' : 'other') : target.left.kind) : '';
  const onLeftChange = async (v: string) => {
    if (!rawTarget) return;
    if (v === 'default') return setLeftOverride(null);
    if (v === 'HEAD') return setLeftOverride({ kind: 'commit', rev: 'HEAD' });
    if (v === 'index') return setLeftOverride({ kind: 'index' });
    const rev = await prompt({ title: t('diff.compareWith'), label: t('diff.compareRevLabel'), placeholder: 'main / v1.0 / a1b2c3d' });
    if (rev) setLeftOverride({ kind: 'commit', rev });
  };

  const onRevertHunk = async (h: Hunk) => {
    if (!target || !diff || diff.old.text == null || diff.new.text == null) return;
    const ok = await ask({ title: t('diff.revertHunkTitle'), body: t('diff.revertHunkBody'), danger: true, confirmLabel: t('rollback.confirm') });
    if (!ok) return;
    try {
      await api.diff.writeWorktree(target.repoId, target.file.path, revertHunk(diff.old.text, diff.new.text, h));
      invalidateRepo(target.repoId);
    } catch (e) {
      reportError(e);
    }
  };

  if (!target) return <div className="diff-empty muted">{t('diff.selectFile')}</div>;

  const header = (
    <div className="diff-toolbar">
      <span className="diff-title mono" title={target.file.path}>
        {target.file.origPath ? `${target.file.origPath} → ` : ''}
        {target.file.path}
      </span>
      {target.switchableLeft ? (
        <label className="muted compare-pick">
          <select value={leftOverride ? leftValue : 'default'} onChange={(e) => void onLeftChange(e.target.value)} aria-label={t('diff.compareWith')}>
            <option value="default">{revLabel(t, rawTarget!.left)}</option>
            <option value="HEAD">{t('diff.head')}</option>
            <option value="index">{t('diff.index')}</option>
            <option value="other">{leftOverride?.kind === 'commit' && leftOverride.rev !== 'HEAD' ? leftOverride.rev : t('diff.compareOther')}</option>
          </select>
          {' '}
          {t('diff.vsRight', { right: revLabel(t, target.right) })}
        </label>
      ) : (
        <span className="muted">{t('diff.vs', { left: revLabel(t, target.left), right: revLabel(t, target.right) })}</span>
      )}
      {target.selectable && wsFiltered && <span className="warn-text small-text">{t('diff.partialNeedsExact')}</span>}
      {selectable && sel?.stale && (
        <span className="warn-text small-text">
          {t('diff.partialStale')}{' '}
          <button className="small" onClick={() => setSel(target.repoId, target.file.path, { ...sel, stale: false })}>
            {t('diff.partialConfirm')}
          </button>
        </span>
      )}
      <span className="spacer" />
      <div className="seg" role="group">
        <button className={prefs.mode === 'side' ? 'active' : ''} onClick={() => prefs.set('diff.mode', 'side')}>
          {t('diff.sideBySide')}
        </button>
        <button className={prefs.mode === 'unified' ? 'active' : ''} onClick={() => prefs.set('diff.mode', 'unified')}>
          {t('diff.unified')}
        </button>
      </div>
      <select value={prefs.whitespace} onChange={(e) => prefs.set('diff.whitespace', e.target.value)} aria-label="whitespace">
        {(['none', 'eol', 'all', 'blankLines'] as const).map((w) => (
          <option key={w} value={w}>
            {t(`diff.whitespace.${w}`)}
          </option>
        ))}
      </select>
      <select value={prefs.algorithm} onChange={(e) => prefs.set('diff.algorithm', e.target.value)} aria-label={t('diff.algorithm')}>
        <option value="myers">Myers</option>
        <option value="patience">Patience</option>
        <option value="histogram">Histogram</option>
      </select>
      <label className="check">
        <input type="checkbox" checked={prefs.ignoreCr} onChange={(e) => prefs.set('diff.ignoreCr', String(e.target.checked))} />
        {t('diff.ignoreCr')}
      </label>
      <label className="check">
        <input type="checkbox" checked={prefs.collapse} onChange={(e) => prefs.set('diff.collapse', String(e.target.checked))} />
        {t('diff.collapse')}
      </label>
      <button className="icon-btn" onClick={() => go(-1)} title={t('diff.prev')} aria-label={t('diff.prev')} disabled={!diff?.hunks.length}>
        <Icon name="arrowUp" />
      </button>
      <button className="icon-btn" onClick={() => go(1)} title={t('diff.next')} aria-label={t('diff.next')} disabled={!diff?.hunks.length}>
        <Icon name="arrowDown" />
      </button>
      {diff && diff.hunks.length > 0 && <span className="muted">{t('diff.counter', { current: current + 1, total: diff.hunks.length })}</span>}
    </div>
  );

  let body: ReactNode;
  if (q.isLoading) body = <p className="muted pad">{t('common.loading')}</p>;
  else if (q.isError) body = <p className="error-text pad">{errorMessage(q.error)}</p>;
  else if (diff?.binary)
    body = isImagePath(target.file.path) ? (
      <ImageDiff repoId={target.repoId} path={target.file.path} oldPath={target.file.origPath} left={target.left} right={target.right} />
    ) : (
      <div className="pad">
        <p>{t('diff.binary')}</p>
        <p className="muted">{t('diff.binarySize', { old: diff.old.exists ? bytes(diff.old.size) : '-', new: diff.new.exists ? bytes(diff.new.size) : '-' })}</p>
        <BinaryHashes target={target} />
      </div>
    );
  else if (diff?.tooLarge)
    body = (
      <div className="pad">
        <p>{t('diff.tooLarge')}</p>
        <button onClick={() => setForce(true)}>{t('diff.showAnyway')}</button>
      </div>
    );
  else if (diff) {
    const notices: string[] = [];
    if (diff.old.exists && diff.new.exists && diff.old.eol !== diff.new.eol && diff.old.eol !== 'none' && diff.new.eol !== 'none')
      notices.push(t('diff.eolChange', { old: diff.old.eol.toUpperCase(), new: diff.new.eol.toUpperCase() }));
    if (diff.hunks.length === 0) notices.push(t('diff.noChanges'));
    body = (
      <>
        {notices.length > 0 && <div className="diff-notice">{notices.join(' · ')}</div>}
        <div className="diff-scroll mono" ref={parentRef}>
          <div className="diff-canvas" style={{ height: virt.getTotalSize(), position: 'relative', minWidth: prefs.mode === 'side' ? 0 : lineWidth + (selectable ? 144 : 122) }}>
            {virt.getVirtualItems().map((vi) => {
              const r = rows[vi.index];
              const style = { position: 'absolute' as const, top: 0, left: 0, right: 0, height: ROW_H, transform: `translateY(${vi.start}px)` };
              if (r.kind === 'collapsed')
                return (
                  <button key={vi.key} className="diff-collapsed" style={style} onClick={() => setExpanded(new Set(expanded).add(r.id))}>
                    {t('diff.collapsed', { count: r.count })}
                  </button>
                );
              if ('left' in r) {
                const both = r.left.type === 'changed' && r.right.type === 'changed';
                const ir = both ? inlineRange(r.left.text, r.right.text) : null;
                const firstOfHunk = r.hunk !== null && hunkFirstRow[r.hunk] === vi.index;
                return (
                  <div key={vi.key} className={`diff-row side ${r.hunk === current ? 'current' : ''}`} style={style}>
                    {selLn(r.left.no, 'o', r.hunk, r.left.type) ?? <span className="ln">{r.left.no ?? ''}</span>}
                    <span className={`code ${r.left.type} ${excluded(r.hunk, 'o', r.left.no) ? 'excluded' : ''}`}>
                      <span className="code-inner">
                        <Highlighted text={r.left.text} tokens={r.left.no ? hl.data?.old?.[r.left.no - 1] : undefined} inline={ir ? [ir.prefix, ir.suffixA] : undefined} />
                      </span>
                    </span>
                    <span className="gutter">
                      {firstOfHunk && selectable && hunkBox(r.hunk!)}
                      {firstOfHunk && canRevert && !selectable && (
                        <button className="gutter-btn" title={t('diff.revertHunk')} aria-label={t('diff.revertHunk')} onClick={() => onRevertHunk(diff.hunks[r.hunk!])}>
                          »
                        </button>
                      )}
                    </span>
                    {selLn(r.right.no, 'n', r.hunk, r.right.type) ?? <span className="ln">{r.right.no ?? ''}</span>}
                    <span className={`code ${r.right.type} ${excluded(r.hunk, 'n', r.right.no) ? 'excluded' : ''}`}>
                      <span className="code-inner">
                        <Highlighted text={r.right.text} tokens={r.right.no ? hl.data?.new?.[r.right.no - 1] : undefined} inline={ir ? [ir.prefix, ir.suffixB] : undefined} />
                      </span>
                    </span>
                  </div>
                );
              }
              const l = r.line;
              const tokens = l.type === 'removed' ? (l.oldNo ? hl.data?.old?.[l.oldNo - 1] : undefined) : l.newNo ? hl.data?.new?.[l.newNo - 1] : undefined;
              return (
                <div key={vi.key} className={`diff-row unified ${selectable ? 'selectable' : ''} ${l.hunk === current ? 'current' : ''}`} style={style}>
                  {selectable && <span className="gutter">{l.hunk !== null && hunkFirstRow[l.hunk] === vi.index && hunkBox(l.hunk)}</span>}
                  {(l.type === 'removed' && selLn(l.oldNo, 'o', l.hunk, l.type)) || <span className="ln">{l.oldNo ?? ''}</span>}
                  {(l.type === 'added' && selLn(l.newNo, 'n', l.hunk, l.type)) || <span className="ln">{l.newNo ?? ''}</span>}
                  <span
                    className={`code ${l.type} ${
                      l.type !== 'context' && excluded(l.hunk, l.type === 'removed' ? 'o' : 'n', l.type === 'removed' ? l.oldNo : l.newNo) ? 'excluded' : ''
                    }`}
                  >
                    <span className="sign">{l.type === 'added' ? '+' : l.type === 'removed' ? '−' : ' '}</span>
                    <Highlighted text={l.text} tokens={tokens} />
                  </span>
                </div>
              );
            })}
          </div>
        </div>
        {prefs.mode === 'side' && <div className="diff-side-x" ref={horizontalRef} tabIndex={0} role="region" aria-label={t('diff.horizontalScroll')}
          onKeyDown={(event) => {
            const bar = event.currentTarget;
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            bar.scrollLeft = event.key === 'Home' ? 0 : event.key === 'End' ? bar.scrollWidth : bar.scrollLeft + (event.key === 'ArrowLeft' ? -80 : 80);
          }}
          onScroll={(event) => parentRef.current?.style.setProperty('--diff-offset', `${-event.currentTarget.scrollLeft}px`)}>
          <div style={{ height: 1, width: Math.max(viewportWidth, lineWidth + 12 + (viewportWidth + 118) / 2) }} />
        </div>}
      </>
    );
  }

  return (
    <div className="diff-viewer">
      {header}
      {body}
    </div>
  );
}

/** 非图片二进制：显示两侧的 blob 哈希（D-05） */
function BinaryHashes({ target }: { target: DiffTarget }) {
  const toRev = (r: Rev) => (r.kind === 'worktree' ? null : r.kind === 'index' ? '' : r.rev);
  const q = useQuery({
    queryKey: ['repo', target.repoId, 'blobHash', target.file.path, target.left, target.right],
    queryFn: async () => {
      const [a, b] = await Promise.all([
        api.compare.blob(target.repoId, toRev(target.left), target.file.origPath ?? target.file.path),
        api.compare.blob(target.repoId, toRev(target.right), target.file.path),
      ]);
      return { a: a.oid, b: b.oid };
    },
  });
  if (!q.data) return null;
  return (
    <p className="muted mono small-text">
      {q.data.a ? q.data.a.slice(0, 12) : '-'} → {q.data.b ? q.data.b.slice(0, 12) : '-'}
    </p>
  );
}

/** 已展开的折叠块：用未折叠的完整行替换 */
function expandRows(rows: Row[], expanded: Set<string>, diff: FileDiff): Row[] {
  if (expanded.size === 0) return rows;
  const full = buildSideBySide(diff.old.text, diff.new.text, diff.hunks, false);
  return mergeExpanded(rows, full, expanded, (r) => (r.kind === 'line' ? `${r.left.no}:${r.right.no}` : ''));
}

function expandUnified(rows: UnifiedRow[], expanded: Set<string>, diff: FileDiff): UnifiedRow[] {
  if (expanded.size === 0) return rows;
  const full = buildUnified(diff.old.text, diff.new.text, diff.hunks, false);
  return mergeExpanded(rows, full, expanded, (r) => (r.kind === 'line' ? `${r.line.oldNo}:${r.line.newNo}` : ''));
}

function mergeExpanded<T extends { kind: string }>(rows: T[], full: T[], expanded: Set<string>, key: (r: T) => string): T[] {
  const out: T[] = [];
  const index = new Map(full.map((r, i) => [key(r), i]));
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] as T & { id?: string; count?: number };
    if (r.kind === 'collapsed' && r.id && expanded.has(r.id)) {
      // 找到折叠块前一行在完整列表中的位置，插入被折叠的行
      const prev = out.length ? index.get(key(out[out.length - 1])) ?? -1 : -1;
      for (let k = prev + 1; k <= prev + (r.count ?? 0) && k < full.length; k++) out.push(full[k]);
    } else out.push(r);
  }
  return out;
}
