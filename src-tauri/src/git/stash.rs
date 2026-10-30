//! Stash（C-10，specs/04 第 5 节）。
//!
//! stash 以完整哈希标识（而非 stash@{n}），避免列表变化后序号错位删错条目。

use super::branch::IntegrateResult;
use super::log::{parse_name_status_z, CommitFile};
use super::parse::FS;
use super::runner::{chunk_paths, RunOpts};
use super::{check_arg, Repo};
use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StashEntry {
    /// stash@{n}
    pub selector: String,
    pub index: u32,
    pub hash: String,
    /// 创建 stash 时 HEAD 所在提交
    pub base: String,
    pub has_untracked: bool,
    /// 原始说明，例如 "On main: 调试代码" / "WIP on main: a1b2c3d msg"
    pub message: String,
    /// 从说明中解析出的分支名
    pub branch: Option<String>,
    pub time: i64,
}

/// 解析 `stash list --format=%gd%x1f%H%x1f%P%x1f%gs%x1f%ct`
pub fn parse_stash_list(text: &str) -> Vec<StashEntry> {
    text.lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.split(FS).collect();
            if f.len() < 5 {
                return None;
            }
            let selector = f[0].to_string();
            let index = selector
                .strip_prefix("stash@{")
                .and_then(|s| s.strip_suffix('}'))
                .and_then(|s| s.parse().ok())
                .unwrap_or(0);
            let parents: Vec<&str> = f[2].split_whitespace().collect();
            let message = f[3].to_string();
            let branch = message
                .strip_prefix("WIP on ")
                .or_else(|| message.strip_prefix("On "))
                .and_then(|s| s.split_once(':'))
                .map(|(b, _)| b.to_string())
                .filter(|b| b != "(no branch)");
            Some(StashEntry {
                selector,
                index,
                hash: f[1].to_string(),
                base: parents.first().map(|s| s.to_string()).unwrap_or_default(),
                has_untracked: parents.len() >= 3,
                message,
                branch,
                time: f[4].trim().parse().unwrap_or(0),
            })
        })
        .collect()
}

pub fn list(repo: &Repo) -> AppResult<Vec<StashEntry>> {
    let out = repo.exec(&["stash", "list", "--format=%gd%x1f%H%x1f%P%x1f%gs%x1f%ct"], &RunOpts::read())?;
    if out.code != 0 {
        // 仓库尚无提交时 refs/stash 不存在
        return Ok(Vec::new());
    }
    Ok(parse_stash_list(&out.text()))
}

/// 按哈希找到当前的 stash@{n}
fn selector_of(repo: &Repo, hash: &str) -> AppResult<String> {
    check_arg("stash", hash)?;
    list(repo)?
        .into_iter()
        .find(|s| s.hash == hash)
        .map(|s| s.selector)
        .ok_or_else(|| AppError::new("stash.notFound").param("hash", hash))
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct StashCreateReq {
    pub message: String,
    /// 为空表示全部改动
    pub paths: Vec<String>,
    pub include_untracked: bool,
    /// 保留暂存区内容（--keep-index）
    pub keep_index: bool,
}

pub fn create(repo: &Repo, req: &StashCreateReq) -> AppResult<()> {
    if repo.head_oid().is_none() {
        return Err(AppError::new("stash.noCommit"));
    }
    let mut args: Vec<String> = vec!["stash".into(), "push".into()];
    if req.include_untracked {
        args.push("--include-untracked".into());
    }
    if req.keep_index {
        args.push("--keep-index".into());
    }
    let msg = req.message.trim();
    if !msg.is_empty() {
        args.push("-m".into());
        args.push(msg.to_string());
    }
    if !req.paths.is_empty() {
        // stash push 的 pathspec 不能分批执行（每批会生成一个 stash），超长时整体失败给出提示
        let chunks = chunk_paths(&req.paths);
        if chunks.len() > 1 {
            return Err(AppError::new("stash.tooManyPaths").param("count", req.paths.len()));
        }
        for p in &req.paths {
            repo.join(p)?;
        }
        args.push("--".into());
        args.extend(req.paths.iter().map(|p| format!(":(literal){}", p)));
    }
    // GIT_LITERAL_PATHSPECS also affects stash's internal clean command; use per-path magic instead.
    let out = repo.exec(&args, &RunOpts::default())?;
    if out.code != 0 {
        return Err(super::runner::classify(&out.stderr, &out.text()));
    }
    if out.text().contains("No local changes to save") {
        return Err(AppError::new("stash.nothing"));
    }
    Ok(())
}

fn has_unmerged(repo: &Repo) -> bool {
    repo.exec(&["ls-files", "-u"], &RunOpts::read())
        .map(|o| !o.stdout.is_empty())
        .unwrap_or(false)
}

/// 应用 / 弹出。产生冲突时 conflicts=true（pop 冲突时 git 不会删除 stash）
pub fn apply(repo: &Repo, hash: &str, pop: bool, restore_index: bool) -> AppResult<IntegrateResult> {
    let sel = selector_of(repo, hash)?;
    let mut args = vec!["stash", if pop { "pop" } else { "apply" }];
    if restore_index {
        args.push("--index");
    }
    args.push(sel.as_str());
    let out = repo.exec(&args, &RunOpts::literal())?;
    let output = format!("{}{}", out.text(), out.stderr);
    if out.code == 0 {
        return Ok(IntegrateResult { conflicts: false, output });
    }
    if has_unmerged(repo) {
        return Ok(IntegrateResult { conflicts: true, output });
    }
    Err(super::runner::classify(&out.stderr, &out.text()))
}

pub fn drop(repo: &Repo, hash: &str) -> AppResult<()> {
    let sel = selector_of(repo, hash)?;
    repo.write(&["stash", "drop", "-q", sel.as_str()])?;
    Ok(())
}

/// 从 stash 创建分支：检出 stash 的基础提交并应用，成功后删除该 stash
pub fn branch(repo: &Repo, hash: &str, name: &str) -> AppResult<()> {
    super::branch::validate_name(repo, name)?;
    let sel = selector_of(repo, hash)?;
    repo.write(&["stash", "branch", name, sel.as_str()])?;
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StashFile {
    #[serde(flatten)]
    pub file: CommitFile,
    /// 来自未跟踪文件部分（stash^3）
    pub untracked: bool,
}

/// stash 中的文件：已跟踪部分为 base..stash，未跟踪部分为 stash^3 的树
pub fn files(repo: &Repo, hash: &str) -> AppResult<Vec<StashFile>> {
    check_arg("stash", hash)?;
    let base = format!("{}^1", hash);
    let out = repo.read(&["diff-tree", "-r", "-z", "-M", "--name-status", "--no-commit-id", base.as_str(), hash])?;
    let mut res: Vec<StashFile> = parse_name_status_z(&out.stdout)
        .into_iter()
        .map(|f| StashFile { file: f, untracked: false })
        .collect();
    let u = format!("{}^3", hash);
    let probe = repo.exec(&["rev-parse", "--verify", "-q", u.as_str()], &RunOpts::read())?;
    if probe.code == 0 {
        let t = repo.read(&["ls-tree", "-r", "-z", "--name-only", u.as_str()])?;
        for p in String::from_utf8_lossy(&t.stdout).split('\0').filter(|s| !s.is_empty()) {
            res.push(StashFile {
                file: CommitFile { status: "A".into(), path: p.to_string(), old_path: None },
                untracked: true,
            });
        }
    }
    Ok(res)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_list() {
        let t = "stash@{0}\u{1f}h0\u{1f}b0 i0 u0\u{1f}On main: 调试\u{1f}100\nstash@{1}\u{1f}h1\u{1f}b1 i1\u{1f}WIP on feature/x: abc msg\u{1f}99\n";
        let s = parse_stash_list(t);
        assert_eq!(s.len(), 2);
        assert_eq!(s[0].index, 0);
        assert!(s[0].has_untracked);
        assert_eq!(s[0].branch.as_deref(), Some("main"));
        assert_eq!(s[1].index, 1);
        assert!(!s[1].has_untracked);
        assert_eq!(s[1].branch.as_deref(), Some("feature/x"));
        assert_eq!(s[1].base, "b1");
    }
}
