//! 部分提交（C-03，specs/04 第 2.2 节 3c）。
//!
//! 不生成 patch 再 `git apply --cached`，而是直接计算"基础版本 + 选中改动"的完整内容，
//! 用 `hash-object -w` 写入对象库，再 `update-index --cacheinfo` 放进 index。
//! 这样不受 CRLF、无结尾换行、上下文偏移等 patch 边界问题影响（specs/08 风险项）。
//! 同时支持 hunk 级与行级选择。

use super::runner::RunOpts;
use super::Repo;
use crate::error::{AppError, AppResult};
use serde::Deserialize;

/// 一个被（部分）选中的 hunk，行号与 `git diff -U0` 的 hunk 头一致（1 起始）
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HunkSelection {
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    /// 选中的删除行（旧文件行号）；None 表示该 hunk 的全部删除行
    #[serde(default)]
    pub removed: Option<Vec<u32>>,
    /// 选中的新增行（新文件行号）；None 表示全部新增行
    #[serde(default)]
    pub added: Option<Vec<u32>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PartialFile {
    pub path: String,
    pub hunks: Vec<HunkSelection>,
}

/// 按行切分并保留行尾（\n / \r\n），保证未改动部分逐字节不变
fn lines_keep(text: &str) -> Vec<&str> {
    text.split_inclusive('\n').collect()
}

fn eol_of(text: &str) -> &'static str {
    if text.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    }
}

fn push_line(out: &mut String, line: &str, eol: &str) {
    if !out.is_empty() && !out.ends_with('\n') {
        // 上一行是无结尾换行的最后一行，后面还要接内容
        out.push_str(eol);
    }
    out.push_str(line);
}

/// 在 old 的基础上只应用选中的改动，得到要写入 index 的内容
pub fn apply_selection(old: &str, new: &str, hunks: &[HunkSelection]) -> AppResult<String> {
    let ol = lines_keep(old);
    let nl = lines_keep(new);
    let eol = eol_of(if new.is_empty() { old } else { new });
    let mut sorted: Vec<&HunkSelection> = hunks.iter().collect();
    sorted.sort_by_key(|h| h.old_start);

    let bad = || AppError::new("partial.invalidSelection");
    let mut out = String::with_capacity(old.len().max(new.len()));
    let mut cursor = 0usize; // old 中下一行（0 起始）
    for h in sorted {
        // -U0 约定：行数为 0 时 start 指向插入/删除位置之前的一行
        let o0 = if h.old_lines == 0 { h.old_start as usize } else { (h.old_start as usize).checked_sub(1).ok_or_else(bad)? };
        let n0 = if h.new_lines == 0 { h.new_start as usize } else { (h.new_start as usize).checked_sub(1).ok_or_else(bad)? };
        let o1 = o0 + h.old_lines as usize;
        let n1 = n0 + h.new_lines as usize;
        if o0 < cursor || o1 > ol.len() || n1 > nl.len() {
            return Err(bad());
        }
        for l in &ol[cursor..o0] {
            push_line(&mut out, l, eol);
        }
        for (i, l) in ol[o0..o1].iter().enumerate() {
            let line_no = (o0 + i + 1) as u32;
            let remove = h.removed.as_ref().map(|v| v.contains(&line_no)).unwrap_or(true);
            if !remove {
                push_line(&mut out, l, eol);
            }
        }
        for (i, l) in nl[n0..n1].iter().enumerate() {
            let line_no = (n0 + i + 1) as u32;
            let add = h.added.as_ref().map(|v| v.contains(&line_no)).unwrap_or(true);
            if add {
                push_line(&mut out, l, eol);
            }
        }
        cursor = o1;
    }
    for l in &ol[cursor..] {
        push_line(&mut out, l, eol);
    }
    Ok(out)
}

fn file_mode(repo: &Repo, path: &str) -> String {
    // 优先 index 中记录的模式，其次 HEAD，最后按普通文件
    // 路径按字面量匹配，避免 a[1].txt 匹配到 a1.txt
    let from = |args: &[&str]| -> Option<String> {
        repo.exec(args, &RunOpts { read_only: true, literal_pathspecs: true, ..Default::default() })
            .ok()
            .filter(|o| o.code == 0)
            .and_then(|o| o.text().split_whitespace().next().map(String::from))
            .filter(|m| m.len() == 6)
    };
    if let Some(m) = from(&["ls-files", "-s", "--", path]) {
        return m;
    }
    if let Some(m) = from(&["ls-tree", "HEAD", "--", path]) {
        return m;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(p) = repo.join(path) {
            if let Ok(md) = std::fs::metadata(p) {
                if md.permissions().mode() & 0o111 != 0 {
                    return "100755".into();
                }
            }
        }
    }
    "100644".into()
}

/// 把部分选择写入 index。基础版本为 HEAD（无 HEAD 或新文件时为空）。
pub fn stage_partial(repo: &Repo, f: &PartialFile) -> AppResult<()> {
    let abs = repo.join(&f.path)?;
    let unsupported = || AppError::new("partial.unsupported").param("path", &f.path);
    // 符号链接 / 子模块不支持部分提交（读取会跟随链接，提交出错误内容）
    let md = std::fs::symlink_metadata(&abs).map_err(|_| AppError::new("diff.fileNotFound").param("path", &f.path))?;
    if !md.is_file() {
        return Err(unsupported());
    }
    let mode = file_mode(repo, &f.path);
    if mode == "120000" || mode == "160000" {
        return Err(unsupported());
    }
    let new_raw = std::fs::read(&abs)?;
    if new_raw.iter().take(8000).any(|&c| c == 0) {
        return Err(AppError::new("partial.binary").param("path", &f.path));
    }
    // 基础版本用工作区形式（smudge 后），与差异视图中的 hunk 坐标一致；
    // 写入时 hash-object --path 再做 clean 转换，与 git add 的结果一致
    let spec = format!("HEAD:{}", f.path);
    let old_raw = super::diff::blob(repo, &spec)?.unwrap_or_default();
    let old = String::from_utf8(old_raw).map_err(|_| AppError::new("partial.encoding").param("path", &f.path))?;
    let new = String::from_utf8(new_raw).map_err(|_| AppError::new("partial.encoding").param("path", &f.path))?;
    let content = apply_selection(&old, &new, &f.hunks)?;

    // --path 让 git 按该路径的 .gitattributes 做 clean 过滤（如 autocrlf），与 git add 一致
    let path_arg = format!("--path={}", f.path);
    let oid = repo
        .run_with(
            &["hash-object", "-w", "--stdin", path_arg.as_str()],
            &RunOpts { stdin: Some(content.into_bytes()), ..Default::default() },
        )?
        .trimmed();
    let info = format!("{},{},{}", mode, oid, f.path);
    repo.write(&["update-index", "--add", "--cacheinfo", info.as_str()])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn h(os: u32, ol: u32, ns: u32, nl: u32) -> HunkSelection {
        HunkSelection { old_start: os, old_lines: ol, new_start: ns, new_lines: nl, removed: None, added: None }
    }

    #[test]
    fn hunk_level() {
        let old = "a\nb\nc\nd\n";
        let new = "a\nB\nc\nd\ne\n";
        // hunk1: -2,1 +2,1 ; hunk2: -4,0 +5,1
        assert_eq!(apply_selection(old, new, &[h(2, 1, 2, 1)]).unwrap(), "a\nB\nc\nd\n");
        assert_eq!(apply_selection(old, new, &[h(4, 0, 5, 1)]).unwrap(), "a\nb\nc\nd\ne\n");
        assert_eq!(apply_selection(old, new, &[h(2, 1, 2, 1), h(4, 0, 5, 1)]).unwrap(), new);
        assert_eq!(apply_selection(old, new, &[]).unwrap(), old);
    }

    #[test]
    fn insert_at_top_and_delete() {
        let old = "a\nb\n";
        let new = "x\na\n";
        // -0,0 +1,1 ; -2,1 +2,0
        assert_eq!(apply_selection(old, new, &[h(0, 0, 1, 1)]).unwrap(), "x\na\nb\n");
        assert_eq!(apply_selection(old, new, &[h(2, 1, 2, 0)]).unwrap(), "a\n");
    }

    #[test]
    fn line_level() {
        let old = "a\nb\nc\n";
        let new = "a\nB1\nB2\nc\n";
        let mut s = h(2, 1, 2, 2);
        s.added = Some(vec![2]);
        s.removed = Some(vec![2]);
        assert_eq!(apply_selection(old, new, &[s.clone()]).unwrap(), "a\nB1\nc\n");
        s.removed = Some(vec![]);
        assert_eq!(apply_selection(old, new, &[s]).unwrap(), "a\nb\nB1\nc\n");
    }

    #[test]
    fn crlf_and_no_trailing_newline() {
        let old = "a\r\nb";
        let new = "a\r\nb\r\nc";
        // git: -2 +2,2
        let r = apply_selection(old, new, &[h(2, 1, 2, 2)]).unwrap();
        assert_eq!(r, new);
        let mut s = h(2, 1, 2, 2);
        s.removed = Some(vec![]);
        s.added = Some(vec![3]);
        assert_eq!(apply_selection(old, new, &[s]).unwrap(), "a\r\nb\r\nc");
    }

    #[test]
    fn rejects_out_of_range() {
        assert!(apply_selection("a\n", "a\n", &[h(5, 1, 5, 1)]).is_err());
    }
}
