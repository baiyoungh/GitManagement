// 部分提交（C-03）的选择模型。纯函数，便于单测。
//
// 默认一个文件的所有改动都被选中；用户在差异视图中取消某个 hunk 或某一行时记录"排除项"。
// 排除项按 hunk 的**内容**（删除行 + 新增行文本）标识，而不是行号：
// 用户之后编辑了文件的其他位置、hunk 行号整体偏移时，排除项仍然跟着原来的 hunk 走。
// 被排除的 hunk 内容变化（无法再匹配）时，选择标记为 stale，提交被阻止，直到用户重新确认（失败即关闭）。
import type { Hunk, HunkSelection } from '../api/types';
import { splitLines } from './diffModel';

export interface FileSelection {
  /** 当前 hunk 列表（与工作区内容对应） */
  hunks: Hunk[];
  /** 与 hunks 一一对应的内容标识 */
  keys: string[];
  /** 被排除的 hunk（内容标识） */
  excludedHunks: string[];
  /** 被排除的行：`${key}#o${i}`（hunk 内第 i 个删除行）/ `${key}#n${i}`（第 i 个新增行） */
  excludedLines: string[];
  /** 有排除项对应的 hunk 已经不存在，需要用户重新确认 */
  stale?: boolean;
}

/** git -U0 约定：行数为 0 时 start 指向前一行 */
function range(start: number, count: number): number[] {
  if (count === 0) return [];
  return Array.from({ length: count }, (_, i) => start + i);
}

export function removedLines(h: Hunk): number[] {
  return range(h.oldStart, h.oldLines);
}

export function addedLines(h: Hunk): number[] {
  return range(h.newStart, h.newLines);
}

/** 按内容生成 hunk 标识；内容完全相同的 hunk 加序号区分 */
export function hunkKeys(oldText: string | null | undefined, newText: string | null | undefined, hunks: Hunk[]): string[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const seen = new Map<string, number>();
  return hunks.map((h) => {
    const rem = removedLines(h).map((n) => a[n - 1] ?? '');
    const add = addedLines(h).map((n) => b[n - 1] ?? '');
    const base = `${rem.join('\n')}\u0000${add.join('\n')}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return `${hash(base)}@${n}`;
  });
}

/** FNV-1a，只用于生成紧凑的标识 */
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36) + s.length.toString(36);
}

const lineId = (key: string, side: 'o' | 'n', offset: number) => `${key}#${side}${offset}`;

function lineIdsOf(sel: FileSelection, i: number): string[] {
  const h = sel.hunks[i];
  const k = sel.keys[i];
  return [...removedLines(h).map((_, j) => lineId(k, 'o', j)), ...addedLines(h).map((_, j) => lineId(k, 'n', j))];
}

export type SelState = 'all' | 'none' | 'partial';

export function hunkState(sel: FileSelection | undefined, i: number): SelState {
  if (!sel || !sel.keys[i]) return 'all';
  if (sel.excludedHunks.includes(sel.keys[i])) return 'none';
  const ex = new Set(sel.excludedLines);
  const lines = lineIdsOf(sel, i);
  const off = lines.filter((l) => ex.has(l)).length;
  return off === 0 ? 'all' : off === lines.length ? 'none' : 'partial';
}

/** side + 文件行号 → 是否包含 */
export function lineIncluded(sel: FileSelection | undefined, i: number, side: 'o' | 'n', lineNo: number): boolean {
  if (!sel || !sel.keys[i]) return true;
  const k = sel.keys[i];
  if (sel.excludedHunks.includes(k)) return false;
  const h = sel.hunks[i];
  const offset = lineNo - (side === 'o' ? h.oldStart : h.newStart);
  return !sel.excludedLines.includes(lineId(k, side, offset));
}

export function fileState(sel: FileSelection | undefined): SelState {
  if (!sel || sel.hunks.length === 0) return 'all';
  const states = sel.hunks.map((_, i) => hunkState(sel, i));
  if (states.every((s) => s === 'all')) return 'all';
  if (states.every((s) => s === 'none')) return 'none';
  return 'partial';
}

function base(sel: FileSelection | undefined, hunks: Hunk[], keys: string[]): FileSelection {
  return sel ? { ...sel, hunks, keys } : { hunks, keys, excludedHunks: [], excludedLines: [] };
}

/** 切换整个 hunk：全选 → 全不选；部分/全不选 → 全选 */
export function toggleHunk(sel: FileSelection | undefined, hunks: Hunk[], keys: string[], i: number): FileSelection {
  const s = base(sel, hunks, keys);
  const k = keys[i];
  const st = hunkState(s, i);
  const excludedLines = s.excludedLines.filter((l) => !l.startsWith(`${k}#`));
  const excludedHunks = s.excludedHunks.filter((x) => x !== k);
  if (st === 'all') excludedHunks.push(k);
  return { ...s, excludedHunks, excludedLines };
}

export function toggleLine(sel: FileSelection | undefined, hunks: Hunk[], keys: string[], i: number, side: 'o' | 'n', lineNo: number): FileSelection {
  const s = base(sel, hunks, keys);
  const k = keys[i];
  const h = hunks[i];
  const id = lineId(k, side, lineNo - (side === 'o' ? h.oldStart : h.newStart));
  if (s.excludedHunks.includes(k)) {
    // 整块被排除时点某一行：变为只选这一行
    const others = lineIdsOf(s, i).filter((l) => l !== id);
    return {
      ...s,
      excludedHunks: s.excludedHunks.filter((x) => x !== k),
      excludedLines: [...s.excludedLines.filter((l) => !l.startsWith(`${k}#`)), ...others],
    };
  }
  const has = s.excludedLines.includes(id);
  return { ...s, excludedLines: has ? s.excludedLines.filter((l) => l !== id) : [...s.excludedLines, id] };
}

/** 全部选中 / 全部排除 */
export function setAll(hunks: Hunk[], keys: string[], on: boolean): FileSelection | undefined {
  return on ? undefined : { hunks, keys, excludedHunks: [...keys], excludedLines: [] };
}

/**
 * 差异刷新后按内容对齐。排除项对应的 hunk 仍然存在时跟随它（行号可能已变化）。
 * 有排除项的 hunk 消失或内容变化时（无法确定对应关系），失败即关闭：
 * 所有新出现的 hunk 默认排除，并标记 stale 提示用户重新确认。
 */
export function reconcile(sel: FileSelection | undefined, hunks: Hunk[], keys: string[]): FileSelection | undefined {
  if (!sel) return undefined;
  const present = new Set(keys);
  const keyOfLine = (l: string) => l.slice(0, l.indexOf('#'));
  const excludedHunks = sel.excludedHunks.filter((k) => present.has(k));
  const excludedLines = sel.excludedLines.filter((l) => present.has(keyOfLine(l)));
  const lost = excludedHunks.length !== sel.excludedHunks.length || excludedLines.length !== sel.excludedLines.length;
  if (lost) {
    const known = new Set(sel.keys);
    const fresh = keys.filter((k) => !known.has(k) && !excludedHunks.includes(k));
    return { hunks, keys, excludedHunks: [...excludedHunks, ...fresh], excludedLines, stale: true };
  }
  const same = keys.length === sel.keys.length && keys.every((k, i) => k === sel.keys[i]) && hunks.every((h, i) => sameHunk(h, sel.hunks[i]));
  if (same) return sel;
  if (!sel.stale && excludedHunks.length === 0 && excludedLines.length === 0) return undefined;
  return { ...sel, hunks, keys };
}

export function sameHunk(a: Hunk, b: Hunk | undefined): boolean {
  return !!b && a.oldStart === b.oldStart && a.oldLines === b.oldLines && a.newStart === b.newStart && a.newLines === b.newLines;
}

/** 转换为后端请求（使用当前行号）；全部排除时返回空数组 */
export function toRequest(sel: FileSelection): HunkSelection[] {
  const out: HunkSelection[] = [];
  const ex = new Set(sel.excludedLines);
  sel.hunks.forEach((h, i) => {
    if (hunkState(sel, i) === 'none') return;
    const k = sel.keys[i];
    const rem = removedLines(h);
    const add = addedLines(h);
    const remSel = rem.filter((_, j) => !ex.has(lineId(k, 'o', j)));
    const addSel = add.filter((_, j) => !ex.has(lineId(k, 'n', j)));
    out.push({
      oldStart: h.oldStart,
      oldLines: h.oldLines,
      newStart: h.newStart,
      newLines: h.newLines,
      removed: remSel.length === rem.length ? null : remSel,
      added: addSel.length === add.length ? null : addSel,
    });
  });
  return out;
}
