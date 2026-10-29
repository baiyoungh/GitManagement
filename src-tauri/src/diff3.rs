//! diff3 三方合并块计算（specs/05 第 2.2、2.3 节；X-03、X-04）。
//!
//! 以 Base 为参照，分别计算 Base→Ours、Base→Theirs 的行级差异，再把重叠的改动区间合并为块：
//! - 只有一侧改动 → 非冲突块（ours / theirs）
//! - 两侧改动且内容相同 → 非冲突块（both）
//! - 两侧改动且内容不同 → 冲突块
//!
//! 不依赖工作区文件中的 `<<<<<<<` 标记。

use serde::Serialize;
use similar::{capture_diff_slices, Algorithm, DiffOp};

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum BlockKind {
    /// 两侧都没改
    Unchanged,
    /// 只有我方改动
    Ours,
    /// 只有对方改动
    Theirs,
    /// 两侧做了相同改动
    Both,
    /// 冲突
    Conflict,
}

/// 行区间 [start, end)，0 基
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Range {
    pub start: usize,
    pub end: usize,
}

impl Range {
    fn new(start: usize, end: usize) -> Self {
        Self { start, end }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MergeBlock {
    pub kind: BlockKind,
    pub base: Range,
    pub ours: Range,
    pub theirs: Range,
}

/// 一侧相对 Base 的改动区间：base[b0..b1) 被替换为 side[s0..s1)
#[derive(Debug, Clone, Copy)]
struct Change {
    b0: usize,
    b1: usize,
    s0: usize,
    s1: usize,
}

fn changes(base: &[&str], side: &[&str]) -> Vec<Change> {
    let ops = capture_diff_slices(Algorithm::Myers, base, side);
    let mut out: Vec<Change> = Vec::new();
    for op in ops {
        let (b0, b1, s0, s1) = match op {
            DiffOp::Equal { .. } => continue,
            DiffOp::Delete { old_index, old_len, new_index } => (old_index, old_index + old_len, new_index, new_index),
            DiffOp::Insert { old_index, new_index, new_len } => (old_index, old_index, new_index, new_index + new_len),
            DiffOp::Replace { old_index, old_len, new_index, new_len } => {
                (old_index, old_index + old_len, new_index, new_index + new_len)
            }
        };
        // 相邻的 delete+insert 合并为一个改动
        if let Some(last) = out.last_mut() {
            if last.b1 == b0 && last.s1 == s0 {
                last.b1 = b1;
                last.s1 = s1;
                continue;
            }
        }
        out.push(Change { b0, b1, s0, s1 });
    }
    out
}

/// base 中位置 b 在 side 中对应的位置（b 不在任何改动内部时）
fn map_pos(chs: &[Change], b: usize) -> usize {
    let mut offset: isize = 0;
    for c in chs {
        if c.b1 <= b && !(c.b0 == c.b1 && c.b0 == b) {
            offset += (c.s1 - c.s0) as isize - (c.b1 - c.b0) as isize;
        } else if c.b0 >= b {
            break;
        }
    }
    (b as isize + offset) as usize
}

/// 计算三方合并块，覆盖整个文件（含 Unchanged 块）
pub fn merge_blocks(base: &[&str], ours: &[&str], theirs: &[&str]) -> Vec<MergeBlock> {
    let co = changes(base, ours);
    let ct = changes(base, theirs);

    // 把两侧改动按 base 区间合并成簇：区间重叠或相接（纯插入位于同一位置）即归为一簇
    #[derive(Clone, Copy)]
    struct Tagged {
        c: Change,
        side: u8,
    }
    let mut all: Vec<Tagged> = co.iter().map(|&c| Tagged { c, side: 0 }).chain(ct.iter().map(|&c| Tagged { c, side: 1 })).collect();
    all.sort_by(|a, b| a.c.b0.cmp(&b.c.b0).then(a.c.b1.cmp(&b.c.b1)));

    // 与 GNU diff3 一致：两个改动的 base 区间重叠，或首尾相接（含同一位置的纯插入），即视为同一簇；
    // 同一侧的改动只因相接而合并时不算重叠（它们在该侧本就是连续的）。
    let mut clusters: Vec<Vec<Tagged>> = Vec::new();
    for t in all {
        if let Some(cur) = clusters.last_mut() {
            let end = cur.iter().map(|x| x.c.b1).max().unwrap_or(0);
            let touches_other_side = t.c.b0 == end && cur.iter().any(|x| x.side != t.side && x.c.b1 == end);
            if t.c.b0 < end || touches_other_side {
                cur.push(t);
                continue;
            }
        }
        clusters.push(vec![t]);
    }

    let mut blocks = Vec::new();
    let mut b_pos = 0usize;
    for cl in clusters {
        let b0 = cl.iter().map(|x| x.c.b0).min().unwrap();
        let b1 = cl.iter().map(|x| x.c.b1).max().unwrap();
        // 簇之前的未改动区
        if b0 > b_pos {
            blocks.push(MergeBlock {
                kind: BlockKind::Unchanged,
                base: Range::new(b_pos, b0),
                ours: Range::new(map_pos(&co, b_pos), map_pos(&co, b0)),
                theirs: Range::new(map_pos(&ct, b_pos), map_pos(&ct, b0)),
            });
        }
        let side_range = |chs: &[Change], side: u8| -> Range {
            let mine: Vec<&Tagged> = cl.iter().filter(|x| x.side == side).collect();
            if mine.is_empty() {
                return Range::new(map_pos(chs, b0), map_pos(chs, b0) + (b1 - b0));
            }
            // 簇的 base 范围在该侧的映射：起点 = 首个改动前的映射，终点 = 末个改动后的映射
            let first = mine.iter().map(|x| x.c).min_by_key(|c| c.b0).unwrap();
            let last = mine.iter().map(|x| x.c).max_by_key(|c| c.b1).unwrap();
            let start = first.s0 - (first.b0 - b0);
            let end = last.s1 + (b1 - last.b1);
            Range::new(start, end)
        };
        let ro = side_range(&co, 0);
        let rt = side_range(&ct, 1);
        let has_o = cl.iter().any(|x| x.side == 0);
        let has_t = cl.iter().any(|x| x.side == 1);
        let kind = match (has_o, has_t) {
            (true, false) => BlockKind::Ours,
            (false, true) => BlockKind::Theirs,
            _ => {
                if ours[ro.start..ro.end] == theirs[rt.start..rt.end] {
                    BlockKind::Both
                } else {
                    BlockKind::Conflict
                }
            }
        };
        blocks.push(MergeBlock { kind, base: Range::new(b0, b1), ours: ro, theirs: rt });
        b_pos = b1;
    }
    if b_pos < base.len() || blocks.is_empty() {
        blocks.push(MergeBlock {
            kind: BlockKind::Unchanged,
            base: Range::new(b_pos, base.len()),
            ours: Range::new(map_pos(&co, b_pos), ours.len()),
            theirs: Range::new(map_pos(&ct, b_pos), theirs.len()),
        });
    }
    blocks.retain(|b| !(b.kind == BlockKind::Unchanged && b.base.start == b.base.end && b.ours.start == b.ours.end));
    blocks
}

/// 自动合并：所有非冲突块按改动侧取值，冲突块保留 Base（返回结果文本与剩余冲突数）
pub fn auto_merge(base: &[&str], ours: &[&str], theirs: &[&str], blocks: &[MergeBlock]) -> (Vec<String>, usize) {
    let mut out = Vec::new();
    let mut conflicts = 0;
    for b in blocks {
        let lines: &[&str] = match b.kind {
            BlockKind::Unchanged | BlockKind::Conflict => &base[b.base.start..b.base.end],
            BlockKind::Ours | BlockKind::Both => &ours[b.ours.start..b.ours.end],
            BlockKind::Theirs => &theirs[b.theirs.start..b.theirs.end],
        };
        if b.kind == BlockKind::Conflict {
            conflicts += 1;
        }
        out.extend(lines.iter().map(|s| s.to_string()));
    }
    (out, conflicts)
}

/// 拆行：保留行内容，去掉 \n（\r 保留在行尾由调用方处理换行风格）
pub fn split_lines(text: &str) -> Vec<&str> {
    if text.is_empty() {
        return Vec::new();
    }
    let t = text.strip_suffix('\n').unwrap_or(text);
    t.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kinds(b: &[MergeBlock]) -> Vec<BlockKind> {
        b.iter().map(|x| x.kind).collect()
    }

    fn lines(s: &str) -> Vec<&str> {
        split_lines(s)
    }

    #[test]
    fn non_conflicting_both_sides() {
        let base = lines("a\nb\nc\nd\ne\n");
        let ours = lines("A\nb\nc\nd\ne\n");
        let theirs = lines("a\nb\nc\nd\nE\n");
        let bl = merge_blocks(&base, &ours, &theirs);
        assert_eq!(kinds(&bl), vec![BlockKind::Ours, BlockKind::Unchanged, BlockKind::Theirs]);
        let (merged, c) = auto_merge(&base, &ours, &theirs, &bl);
        assert_eq!(c, 0);
        assert_eq!(merged, vec!["A", "b", "c", "d", "E"]);
    }

    #[test]
    fn conflict_same_line() {
        let base = lines("x\npush(remote)\ny\n");
        let ours = lines("x\npush(remote, a)\ny\n");
        let theirs = lines("x\npush(remote, b)\ny\n");
        let bl = merge_blocks(&base, &ours, &theirs);
        assert_eq!(kinds(&bl), vec![BlockKind::Unchanged, BlockKind::Conflict, BlockKind::Unchanged]);
        let c = &bl[1];
        assert_eq!((c.base.start, c.base.end), (1, 2));
        assert_eq!(&ours[c.ours.start..c.ours.end], &["push(remote, a)"]);
        assert_eq!(&theirs[c.theirs.start..c.theirs.end], &["push(remote, b)"]);
        let (merged, n) = auto_merge(&base, &ours, &theirs, &bl);
        assert_eq!(n, 1);
        assert_eq!(merged, vec!["x", "push(remote)", "y"]);
    }

    #[test]
    fn identical_change_is_not_conflict() {
        let base = lines("a\nb\n");
        let ours = lines("a\nB\n");
        let bl = merge_blocks(&base, &ours, &ours);
        assert_eq!(kinds(&bl), vec![BlockKind::Unchanged, BlockKind::Both]);
    }

    #[test]
    fn insertions_at_same_point_conflict() {
        let base = lines("a\nb\n");
        let ours = lines("a\nX\nb\n");
        let theirs = lines("a\nY\nb\n");
        let bl = merge_blocks(&base, &ours, &theirs);
        assert!(bl.iter().any(|b| b.kind == BlockKind::Conflict));
    }

    #[test]
    fn add_add_from_empty_base() {
        // AA 冲突：没有共同祖先，Base 为空
        let base: Vec<&str> = vec![];
        let ours = lines("one\n");
        let theirs = lines("two\n");
        let bl = merge_blocks(&base, &ours, &theirs);
        assert_eq!(kinds(&bl), vec![BlockKind::Conflict]);
    }

    #[test]
    fn deletion_vs_edit_elsewhere() {
        let base = lines("1\n2\n3\n4\n5\n6\n");
        let ours = lines("1\n3\n4\n5\n6\n"); // 删除 2
        let theirs = lines("1\n2\n3\n4\n5\nsix\n");
        let bl = merge_blocks(&base, &ours, &theirs);
        let (m, n) = auto_merge(&base, &ours, &theirs, &bl);
        assert_eq!(n, 0);
        assert_eq!(m, vec!["1", "3", "4", "5", "six"]);
    }

    #[test]
    fn ranges_cover_all_lines() {
        let base = lines("a\nb\nc\nd\ne\nf\ng\n");
        let ours = lines("a\nB\nc\nd\ne\nF\nF2\ng\n");
        let theirs = lines("a\nb\nc\nD\ne\nf\ng\nh\n");
        let bl = merge_blocks(&base, &ours, &theirs);
        let sum = |f: fn(&MergeBlock) -> Range| bl.iter().map(|b| f(b).end - f(b).start).sum::<usize>();
        assert_eq!(sum(|b| b.base), base.len());
        assert_eq!(sum(|b| b.ours), ours.len());
        assert_eq!(sum(|b| b.theirs), theirs.len());
        let (m, n) = auto_merge(&base, &ours, &theirs, &bl);
        assert_eq!(n, 0);
        assert_eq!(m, vec!["a", "B", "c", "D", "e", "F", "F2", "g", "h"]);
    }
}
