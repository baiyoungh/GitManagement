// 根据后端返回的完整文本 + hunk 列表生成并排/统一视图的行模型（D-01 ~ D-03）。纯函数，便于单测。
import type { Hunk } from '../api/types';

export type LineType = 'context' | 'removed' | 'added' | 'changed' | 'empty';

export interface SideLine {
  no: number | null;
  text: string;
  type: LineType;
}

export type Row =
  | { kind: 'line'; left: SideLine; right: SideLine; hunk: number | null }
  | { kind: 'collapsed'; count: number; id: string };

export interface UnifiedLine {
  oldNo: number | null;
  newNo: number | null;
  text: string;
  type: 'context' | 'removed' | 'added';
  hunk: number | null;
}

export type UnifiedRow = { kind: 'line'; line: UnifiedLine } | { kind: 'collapsed'; count: number; id: string };

/** 按 \n 拆行，保留 \r 之外的内容；末尾换行不产生空行 */
export function splitLines(text: string | null | undefined): string[] {
  if (!text) return [];
  const lines = text.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** git -U0 hunk 中 start 的含义：count=0 时 start 指"其后插入"的行号 */
function hunkRange(start: number, count: number): [number, number] {
  // 返回 0 基的 [from, to)
  if (count === 0) return [start, start];
  return [start - 1, start - 1 + count];
}

interface Seg {
  type: 'same' | 'hunk';
  oldFrom: number;
  oldTo: number;
  newFrom: number;
  newTo: number;
  hunk?: number;
}

function segments(oldLen: number, newLen: number, hunks: Hunk[]): Seg[] {
  const segs: Seg[] = [];
  let o = 0;
  let n = 0;
  hunks.forEach((h, idx) => {
    const [of, ot] = hunkRange(h.oldStart, h.oldLines);
    const [nf, nt] = hunkRange(h.newStart, h.newLines);
    if (of > o || nf > n) segs.push({ type: 'same', oldFrom: o, oldTo: of, newFrom: n, newTo: nf });
    segs.push({ type: 'hunk', oldFrom: of, oldTo: ot, newFrom: nf, newTo: nt, hunk: idx });
    o = ot;
    n = nt;
  });
  if (o < oldLen || n < newLen) segs.push({ type: 'same', oldFrom: o, oldTo: oldLen, newFrom: n, newTo: newLen });
  return segs;
}

const CONTEXT = 3;

function collapseRuns<T>(items: T[], isContext: (t: T) => boolean, mkCollapsed: (count: number, id: string) => T, enabled: boolean): T[] {
  if (!enabled) return items;
  const out: T[] = [];
  let i = 0;
  while (i < items.length) {
    if (!isContext(items[i])) {
      out.push(items[i++]);
      continue;
    }
    let j = i;
    while (j < items.length && isContext(items[j])) j++;
    const run = j - i;
    const atStart = i === 0;
    const atEnd = j === items.length;
    const keepHead = atStart ? 0 : CONTEXT;
    const keepTail = atEnd ? 0 : CONTEXT;
    if (run > keepHead + keepTail + 1) {
      for (let k = i; k < i + keepHead; k++) out.push(items[k]);
      out.push(mkCollapsed(run - keepHead - keepTail, `c${i}`));
      for (let k = j - keepTail; k < j; k++) out.push(items[k]);
    } else {
      for (let k = i; k < j; k++) out.push(items[k]);
    }
    i = j;
  }
  return out;
}

export function buildSideBySide(oldText: string | null, newText: string | null, hunks: Hunk[], collapse: boolean): Row[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const rows: Row[] = [];
  for (const s of segments(a.length, b.length, hunks)) {
    if (s.type === 'same') {
      for (let k = 0; k < s.oldTo - s.oldFrom; k++) {
        const oi = s.oldFrom + k;
        const ni = s.newFrom + k;
        rows.push({
          kind: 'line',
          left: { no: oi + 1, text: a[oi] ?? '', type: 'context' },
          right: { no: ni + 1, text: b[ni] ?? '', type: 'context' },
          hunk: null,
        });
      }
    } else {
      const oc = s.oldTo - s.oldFrom;
      const nc = s.newTo - s.newFrom;
      const n = Math.max(oc, nc);
      for (let k = 0; k < n; k++) {
        const hasL = k < oc;
        const hasR = k < nc;
        const both = hasL && hasR;
        rows.push({
          kind: 'line',
          left: hasL
            ? { no: s.oldFrom + k + 1, text: a[s.oldFrom + k], type: both ? 'changed' : 'removed' }
            : { no: null, text: '', type: 'empty' },
          right: hasR
            ? { no: s.newFrom + k + 1, text: b[s.newFrom + k], type: both ? 'changed' : 'added' }
            : { no: null, text: '', type: 'empty' },
          hunk: s.hunk ?? null,
        });
      }
    }
  }
  return collapseRuns<Row>(
    rows,
    (r) => r.kind === 'line' && r.hunk === null,
    (count, id) => ({ kind: 'collapsed', count, id }),
    collapse,
  );
}

export function buildUnified(oldText: string | null, newText: string | null, hunks: Hunk[], collapse: boolean): UnifiedRow[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const rows: UnifiedRow[] = [];
  for (const s of segments(a.length, b.length, hunks)) {
    if (s.type === 'same') {
      for (let k = 0; k < s.oldTo - s.oldFrom; k++) {
        rows.push({
          kind: 'line',
          line: { oldNo: s.oldFrom + k + 1, newNo: s.newFrom + k + 1, text: a[s.oldFrom + k] ?? '', type: 'context', hunk: null },
        });
      }
    } else {
      for (let k = s.oldFrom; k < s.oldTo; k++)
        rows.push({ kind: 'line', line: { oldNo: k + 1, newNo: null, text: a[k], type: 'removed', hunk: s.hunk ?? null } });
      for (let k = s.newFrom; k < s.newTo; k++)
        rows.push({ kind: 'line', line: { oldNo: null, newNo: k + 1, text: b[k], type: 'added', hunk: s.hunk ?? null } });
    }
  }
  return collapseRuns<UnifiedRow>(
    rows,
    (r) => r.kind === 'line' && r.line.type === 'context',
    (count, id) => ({ kind: 'collapsed', count, id }),
    collapse,
  );
}

/**
 * 撤销单个 hunk：把新文本中该 hunk 的行替换为旧文本对应行。
 * 保持原文件的换行符风格与末尾换行。
 */
export function revertHunk(oldText: string, newText: string, hunk: Hunk): string {
  const eol = newText.includes('\r\n') ? '\r\n' : '\n';
  const trailing = newText.length === 0 ? oldText.endsWith('\n') : newText.endsWith('\n');
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const [of, ot] = hunkRange(hunk.oldStart, hunk.oldLines);
  const [nf, nt] = hunkRange(hunk.newStart, hunk.newLines);
  const merged = [...b.slice(0, nf), ...a.slice(of, ot), ...b.slice(nt)];
  if (merged.length === 0) return '';
  return merged.join(eol) + (trailing ? eol : '');
}

/** 行内字符级高亮：返回公共前缀/后缀长度，中间部分标记为改动 */
export function inlineRange(a: string, b: string): { prefix: number; suffixA: number; suffixB: number } {
  let p = 0;
  const max = Math.min(a.length, b.length);
  while (p < max && a[p] === b[p]) p++;
  let s = 0;
  while (s < max - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  return { prefix: p, suffixA: a.length - s, suffixB: b.length - s };
}
