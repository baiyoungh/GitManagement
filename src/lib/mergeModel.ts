// 三栏合并结果模型（specs/05 第 2.2 节；X-03、X-04）。纯函数，便于单测。
//
// 结果栏初始为 Base；每个改动块可"应用左侧 / 应用右侧 / 忽略"。
// 冲突块两侧都应用时按"先左后右"追加。结果文本可被用户直接编辑（编辑后块状态以文本为准）。
import type { MergeBlock, MergeData } from '../api/types';
import { splitLines } from './diffModel';

export interface BlockState {
  /** 已应用我方 */
  ours: boolean;
  /** 已应用对方 */
  theirs: boolean;
  /** 两侧都已处理（应用或忽略） */
  resolved: boolean;
}

export interface MergeModel {
  base: string[];
  ours: string[];
  theirs: string[];
  blocks: MergeBlock[];
  states: BlockState[];
}

export function createModel(d: MergeData): MergeModel {
  return {
    base: splitLines(d.base),
    ours: splitLines(d.ours),
    theirs: splitLines(d.theirs),
    blocks: d.blocks,
    states: d.blocks.map((b) => ({ ours: false, theirs: false, resolved: b.kind === 'unchanged' })),
  };
}

export const isChange = (b: MergeBlock) => b.kind !== 'unchanged';

/** 某块在结果中的内容 */
export function blockResult(m: MergeModel, i: number): string[] {
  const b = m.blocks[i];
  const s = m.states[i];
  const o = m.ours.slice(b.ours.start, b.ours.end);
  const t = m.theirs.slice(b.theirs.start, b.theirs.end);
  if (b.kind === 'both') return s.ours || s.theirs ? o : m.base.slice(b.base.start, b.base.end);
  if (s.ours && s.theirs) return [...o, ...t];
  if (s.ours) return o;
  if (s.theirs) return t;
  return m.base.slice(b.base.start, b.base.end);
}

/** 结果文本的行数组 + 每块在结果中的起始行（用于中间栏定位） */
export function buildResult(m: MergeModel): { lines: string[]; starts: number[] } {
  const lines: string[] = [];
  const starts: number[] = [];
  m.blocks.forEach((_, i) => {
    starts.push(lines.length);
    lines.push(...blockResult(m, i));
  });
  return { lines, starts };
}

function patch(m: MergeModel, i: number, next: Partial<BlockState>): MergeModel {
  const states = m.states.map((s, k) => (k === i ? { ...s, ...next } : s));
  return { ...m, states };
}

/** » / «：应用一侧改动。非冲突块应用后即已解决；冲突块需两侧都处理 */
export function applySide(m: MergeModel, i: number, side: 'ours' | 'theirs'): MergeModel {
  const b = m.blocks[i];
  const s = m.states[i];
  if (b.kind === 'conflict') {
    const next = { ...s, [side]: true };
    // 冲突块：应用了一侧，视为已处理该侧；另一侧需显式应用或忽略
    return patch(m, i, { [side]: true, resolved: next.ours && next.theirs ? true : s.resolved || false });
  }
  return patch(m, i, { [side]: true, resolved: true });
}

/** ×：忽略该块（保留结果当前内容）并标记已解决 */
export function ignoreBlock(m: MergeModel, i: number): MergeModel {
  return patch(m, i, { resolved: true });
}

/** 冲突块：应用一侧后再点另一侧的 × 即完成 */
export function markResolved(m: MergeModel, i: number): MergeModel {
  return patch(m, i, { resolved: true });
}

/** ⚡ 应用所有非冲突改动 */
export function applyNonConflicting(m: MergeModel): MergeModel {
  let next = m;
  m.blocks.forEach((b, i) => {
    if (m.states[i].resolved) return;
    if (b.kind === 'ours') next = applySide(next, i, 'ours');
    else if (b.kind === 'theirs') next = applySide(next, i, 'theirs');
    else if (b.kind === 'both') next = applySide(next, i, 'ours');
  });
  return next;
}

/** 整体接受一侧（"接受左侧 / 接受右侧"按钮） */
export function acceptAll(m: MergeModel, side: 'ours' | 'theirs'): MergeModel {
  return {
    ...m,
    states: m.blocks.map((b) => ({ ours: side === 'ours' && b.kind !== 'unchanged', theirs: side === 'theirs' && b.kind !== 'unchanged', resolved: true })),
  };
}

export function counts(m: MergeModel): { conflicts: number; changes: number } {
  let conflicts = 0;
  let changes = 0;
  m.blocks.forEach((b, i) => {
    if (m.states[i].resolved) return;
    if (b.kind === 'conflict') conflicts++;
    else if (b.kind !== 'unchanged') changes++;
  });
  return { conflicts, changes };
}

export function joinLines(lines: string[], eol: string, trailing = true): string {
  if (lines.length === 0) return '';
  return lines.join(eol) + (trailing ? eol : '');
}
