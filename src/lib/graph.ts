// 提交图布局（L-01）：为每个提交分配列（lane），并给出与下一行之间的连线。纯函数，便于单测。
import type { LogCommit } from '../api/types';

export interface GraphEdge {
  /** 当前行中的起点列 */
  from: number;
  /** 下一行中的终点列 */
  to: number;
  color: number;
}

export interface GraphRow {
  lane: number;
  color: number;
  /** 从本行到下一行的连线 */
  edges: GraphEdge[];
  /** 从上一行进入本行节点的连线来源列（用于绘制上半段） */
  incoming: number[];
  width: number;
}

/**
 * 经典的"活动列"算法：
 * lanes[i] = 期望在第 i 列出现的下一个提交哈希。
 * 处理提交 c 时，找到所有指向 c 的列（合并进来的分支），c 占用最左的那列；
 * c 的第一个父提交继承该列，其余父提交分配新列（或复用已在等待它的列）。
 */
export function layoutGraph(commits: LogCommit[]): GraphRow[] {
  let lanes: (string | null)[] = [];
  let colors: number[] = [];
  let nextColor = 0;
  const rows: GraphRow[] = [];

  for (const c of commits) {
    const incoming: number[] = [];
    lanes.forEach((h, i) => {
      if (h === c.hash) incoming.push(i);
    });
    let lane: number;
    if (incoming.length > 0) {
      lane = incoming[0];
    } else {
      // 新分支头：放在第一个空列
      lane = lanes.indexOf(null);
      if (lane === -1) {
        lane = lanes.length;
        lanes.push(null);
        colors.push(nextColor++);
      } else {
        colors[lane] = nextColor++;
      }
    }
    const color = colors[lane];

    // 计算下一行的 lanes
    const next = [...lanes];
    const nextColors = [...colors];
    for (const i of incoming) next[i] = null;
    const parents = c.parents;
    if (parents.length > 0) {
      next[lane] = parents[0];
      nextColors[lane] = color;
    }
    const parentLanes: number[] = parents.length > 0 ? [lane] : [];
    for (const p of parents.slice(1)) {
      const existing = next.indexOf(p);
      if (existing !== -1) {
        parentLanes.push(existing);
        continue;
      }
      let free = next.indexOf(null);
      if (free === -1) {
        free = next.length;
        next.push(null);
        nextColors.push(0);
      }
      next[free] = p;
      nextColors[free] = nextColor++;
      parentLanes.push(free);
    }

    const edges: GraphEdge[] = [];
    // 当前节点到各父提交所在列
    parentLanes.forEach((pl, k) => edges.push({ from: lane, to: pl, color: k === 0 ? color : nextColors[pl] }));
    // 其他列直通
    lanes.forEach((h, i) => {
      if (h !== null && h !== c.hash && i !== lane) {
        const to = next.indexOf(h);
        if (to !== -1) edges.push({ from: i, to, color: colors[i] });
      }
    });

    // 去掉末尾空列
    while (next.length > 0 && next[next.length - 1] === null) {
      next.pop();
      nextColors.pop();
    }
    rows.push({ lane, color, edges, incoming, width: Math.max(lanes.length, next.length, lane + 1) });
    lanes = next;
    colors = nextColors;
  }
  return rows;
}

export const GRAPH_COLORS = ['#2f6feb', '#1a7f37', '#c2410c', '#8250df', '#bf3989', '#0e7c86', '#9a6700', '#cf222e'];
