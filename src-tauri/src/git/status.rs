//! 仓库状态（R-05、C-01）。

use super::parse::{parse_numstat_z, parse_status_v2, BranchStatus, ChangeKind, FileChange};
use super::runner::RunOpts;
use super::{Repo, EMPTY_TREE};
use crate::error::AppResult;
use serde::Serialize;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RepoOperation {
    Merge,
    Rebase,
    CherryPick,
    Revert,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusResult {
    pub branch: BranchStatus,
    pub files: Vec<FileChange>,
    pub operation: Option<RepoOperation>,
    /// 变基进度 (当前, 总数)
    pub rebase_step: Option<(u32, u32)>,
}

pub fn status(repo: &Repo, with_stats: bool) -> AppResult<StatusResult> {
    let out = repo.read(&[
        "status",
        "--porcelain=v2",
        "-z",
        "--branch",
        "--untracked-files=all",
        "--ignore-submodules=dirty",
    ])?;
    let mut parsed = parse_status_v2(&out.stdout);

    if with_stats && !parsed.files.is_empty() {
        let base = if parsed.branch.oid.is_some() { "HEAD" } else { EMPTY_TREE };
        // 相对 HEAD 的增删行数（暂存 + 未暂存）；失败不影响状态展示
        if let Ok(o) = repo.exec(
            &["diff", "--numstat", "-z", "--no-renames", "--no-ext-diff", base, "--"],
            &RunOpts::read(),
        ) {
            if o.code == 0 {
                let stats = parse_numstat_z(&o.stdout);
                for f in parsed.files.iter_mut() {
                    if let Some((a, d)) = stats.get(&f.path) {
                        f.added = *a;
                        f.removed = *d;
                    }
                }
            }
        }
    }

    let (operation, rebase_step) = operation(repo);
    Ok(StatusResult {
        branch: parsed.branch,
        files: parsed.files,
        operation,
        rebase_step,
    })
}

pub fn operation(repo: &Repo) -> (Option<RepoOperation>, Option<(u32, u32)>) {
    let dir = match repo.git_dir() {
        Ok(d) => d,
        Err(_) => return (None, None),
    };
    for sub in ["rebase-merge", "rebase-apply"] {
        let d = dir.join(sub);
        if d.is_dir() {
            let read = |names: &[&str]| -> Option<u32> {
                names
                    .iter()
                    .find_map(|n| std::fs::read_to_string(d.join(n)).ok())
                    .and_then(|s| s.trim().parse().ok())
            };
            let step = match (read(&["msgnum", "next"]), read(&["end", "last"])) {
                (Some(a), Some(b)) => Some((a, b)),
                _ => None,
            };
            return (Some(RepoOperation::Rebase), step);
        }
    }
    if dir.join("MERGE_HEAD").is_file() {
        return (Some(RepoOperation::Merge), None);
    }
    if dir.join("CHERRY_PICK_HEAD").is_file() {
        return (Some(RepoOperation::CherryPick), None);
    }
    if dir.join("REVERT_HEAD").is_file() {
        return (Some(RepoOperation::Revert), None);
    }
    (None, None)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoSummary {
    pub branch: Option<String>,
    pub detached: bool,
    pub head_short: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub changes: u32,
    pub conflicts: u32,
    pub operation: Option<RepoOperation>,
    pub last_commit_time: Option<i64>,
}

pub fn summary(repo: &Repo) -> AppResult<RepoSummary> {
    let st = status(repo, false)?;
    let last_commit_time = repo
        .exec(&["log", "-1", "--format=%ct"], &RunOpts::read())
        .ok()
        .filter(|o| o.code == 0)
        .and_then(|o| o.trimmed().parse().ok());
    let conflicts = st.files.iter().filter(|f| f.kind == ChangeKind::Conflicted).count() as u32;
    Ok(RepoSummary {
        detached: st.branch.head.is_none() && st.branch.oid.is_some(),
        head_short: st.branch.oid.as_ref().map(|o| o.chars().take(7).collect()),
        branch: st.branch.head,
        upstream: st.branch.upstream,
        ahead: st.branch.ahead,
        behind: st.branch.behind,
        changes: st.files.iter().filter(|f| f.kind != ChangeKind::Ignored).count() as u32,
        conflicts,
        operation: st.operation,
        last_commit_time,
    })
}
