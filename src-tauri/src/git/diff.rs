//! 文件差异（D-01 ~ D-04）。
//!
//! 后端返回左右两侧完整文本 + hunk 列表，前端据此渲染并排/统一视图。
//! hunk 由 `git diff --no-index -U0` 计算，因此忽略空白、diff 算法等选项与 git 行为完全一致。

use super::parse::{parse_unified, Hunk};
use super::runner::RunOpts;
use super::{check_arg, Repo};
use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};

const LARGE_BYTES: usize = 2 * 1024 * 1024;
const LARGE_LINES: usize = 20_000;

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Rev {
    Worktree,
    Index,
    Commit { rev: String },
}

#[derive(Debug, Clone, Copy, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum WhitespaceMode {
    #[default]
    None,
    Eol,
    All,
    BlankLines,
}

#[derive(Debug, Clone, Copy, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DiffAlgorithm {
    #[default]
    Myers,
    Patience,
    Histogram,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct DiffOpts {
    pub whitespace: WhitespaceMode,
    pub ignore_cr_at_eol: bool,
    pub algorithm: DiffAlgorithm,
    /// 超过大文件阈值时仍然渲染
    pub force: bool,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Eol {
    None,
    Lf,
    Crlf,
    Mixed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffSide {
    pub exists: bool,
    pub size: u64,
    /// 二进制或超大文件时为 None
    pub text: Option<String>,
    pub eol: Eol,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub path: String,
    pub old_path: Option<String>,
    pub old: DiffSide,
    pub new: DiffSide,
    pub hunks: Vec<Hunk>,
    pub binary: bool,
    pub too_large: bool,
}

fn read_side(repo: &Repo, rev: &Rev, path: &str) -> AppResult<Option<Vec<u8>>> {
    match rev {
        Rev::Worktree => {
            let p = repo.join(path)?;
            if p.is_file() {
                Ok(Some(std::fs::read(p)?))
            } else {
                Ok(None)
            }
        }
        Rev::Index => blob(repo, &format!(":{}", path)),
        Rev::Commit { rev } => {
            check_arg("rev", rev)?;
            blob(repo, &format!("{}:{}", rev, path))
        }
    }
}

/// 读取版本中的文件内容，并按该路径的属性做 smudge 转换（autocrlf、eol 等），
/// 使其与工作区文件处于同一形式；否则 Windows 下 autocrlf=true 时每一行都会显示为修改。
/// 过滤失败（例如 LFS 无法下载）时退回原始内容。
pub fn blob(repo: &Repo, spec: &str) -> AppResult<Option<Vec<u8>>> {
    let out = repo.exec(&["cat-file", "--filters", spec], &RunOpts::read())?;
    if out.code == 0 {
        return Ok(Some(out.stdout));
    }
    let raw = repo.exec(&["cat-file", "blob", spec], &RunOpts::read())?;
    Ok(if raw.code == 0 { Some(raw.stdout) } else { None })
}

fn is_binary(b: &[u8]) -> bool {
    b.iter().take(8000).any(|&c| c == 0)
}

pub fn detect_eol(text: &str) -> Eol {
    let crlf = text.matches("\r\n").count();
    let lf = text.matches('\n').count();
    match (crlf, lf) {
        (0, 0) => Eol::None,
        (0, _) => Eol::Lf,
        (c, l) if c == l => Eol::Crlf,
        _ => Eol::Mixed,
    }
}

pub fn diff_file(
    repo: &Repo,
    path: &str,
    old_path: Option<&str>,
    left: &Rev,
    right: &Rev,
    opts: &DiffOpts,
) -> AppResult<FileDiff> {
    let old_bytes = read_side(repo, left, old_path.unwrap_or(path))?;
    let new_bytes = read_side(repo, right, path)?;
    if old_bytes.is_none() && new_bytes.is_none() {
        return Err(AppError::new("diff.fileNotFound").param("path", path));
    }
    let old_raw = old_bytes.clone().unwrap_or_default();
    let new_raw = new_bytes.clone().unwrap_or_default();
    let binary = is_binary(&old_raw) || is_binary(&new_raw);

    let old_text = String::from_utf8_lossy(&old_raw).into_owned();
    let new_text = String::from_utf8_lossy(&new_raw).into_owned();
    let too_large = !binary
        && !opts.force
        && (old_raw.len().max(new_raw.len()) > LARGE_BYTES
            || old_text.lines().count().max(new_text.lines().count()) > LARGE_LINES);

    let hunks = if binary || too_large {
        Vec::new()
    } else {
        compute_hunks(repo, &old_raw, &new_raw, opts)?
    };

    let side = |exists: bool, raw: &[u8], text: String| DiffSide {
        exists,
        size: raw.len() as u64,
        eol: if binary { Eol::None } else { detect_eol(&text) },
        text: if binary || too_large { None } else { Some(text) },
    };
    Ok(FileDiff {
        path: path.to_string(),
        old_path: old_path.map(String::from),
        old: side(old_bytes.is_some(), &old_raw, old_text),
        new: side(new_bytes.is_some(), &new_raw, new_text),
        hunks,
        binary,
        too_large,
    })
}

fn compute_hunks(repo: &Repo, old: &[u8], new: &[u8], opts: &DiffOpts) -> AppResult<Vec<Hunk>> {
    if old == new {
        return Ok(Vec::new());
    }
    let dir = tempfile::tempdir()?;
    std::fs::write(dir.path().join("a"), old)?;
    std::fs::write(dir.path().join("b"), new)?;
    let mut args: Vec<&str> = vec!["diff", "--no-index", "--no-color", "--no-ext-diff", "-U0"];
    match opts.whitespace {
        WhitespaceMode::None => {}
        WhitespaceMode::Eol => args.push("--ignore-space-at-eol"),
        WhitespaceMode::All => args.push("--ignore-all-space"),
        WhitespaceMode::BlankLines => args.push("--ignore-blank-lines"),
    }
    if opts.ignore_cr_at_eol {
        args.push("--ignore-cr-at-eol");
    }
    args.push(match opts.algorithm {
        DiffAlgorithm::Myers => "--diff-algorithm=myers",
        DiffAlgorithm::Patience => "--diff-algorithm=patience",
        DiffAlgorithm::Histogram => "--diff-algorithm=histogram",
    });
    args.extend(["--", "a", "b"]);
    let out = repo.git.run(
        dir.path(),
        &args,
        &RunOpts {
            read_only: true,
            ok_codes: vec![1],
            ..Default::default()
        },
    )?;
    Ok(parse_unified(&out.text()).hunks)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn eol() {
        assert_eq!(detect_eol("a\nb\n"), Eol::Lf);
        assert_eq!(detect_eol("a\r\nb\r\n"), Eol::Crlf);
        assert_eq!(detect_eol("a\r\nb\n"), Eol::Mixed);
        assert_eq!(detect_eol("a"), Eol::None);
    }

    #[test]
    fn binary() {
        assert!(is_binary(b"PNG\0\x01"));
        assert!(!is_binary("中文".as_bytes()));
    }
}
