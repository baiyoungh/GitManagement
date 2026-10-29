//! 冲突文件（specs/05 第 2 节；X-01 ~ X-04）。
//!
//! 数据来源：`git ls-files -u -z` 得到各 stage；内容通过 `git show :1:/:2:/:3:<path>` 读取。

use super::runner::RunOpts;
use super::status::{operation, RepoOperation};
use super::Repo;
use crate::diff3::{merge_blocks, split_lines, MergeBlock};
use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictFile {
    pub path: String,
    /// UU / AA / DU / UD / AU / UA / DD
    pub code: String,
    pub has_base: bool,
    pub has_ours: bool,
    pub has_theirs: bool,
    pub binary: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictContext {
    pub operation: Option<RepoOperation>,
    /// 我方名称：merge 时为当前分支；rebase 时为被变基到的上游（"onto"）
    pub ours_label: String,
    /// 对方名称：merge 时为 MERGE_HEAD 的分支名；rebase 时为正在重放的提交
    pub theirs_label: String,
    pub files: Vec<ConflictFile>,
}

fn stage_blob(repo: &Repo, stage: u8, path: &str) -> AppResult<Option<Vec<u8>>> {
    let spec = format!(":{}:{}", stage, path);
    let out = repo.exec(&["cat-file", "blob", spec.as_str()], &RunOpts::read())?;
    Ok(if out.code == 0 { Some(out.stdout) } else { None })
}

fn is_binary(b: &[u8]) -> bool {
    b.iter().take(8000).any(|&c| c == 0)
}

fn code_for(base: bool, ours: bool, theirs: bool) -> &'static str {
    match (base, ours, theirs) {
        (true, true, true) => "UU",
        (false, true, true) => "AA",
        (true, false, true) => "DU",
        (true, true, false) => "UD",
        (false, true, false) => "AU",
        (false, false, true) => "UA",
        _ => "DD",
    }
}

/// 冲突文件列表（X-01）
pub fn list(repo: &Repo) -> AppResult<Vec<ConflictFile>> {
    let out = repo.read(&["ls-files", "-u", "-z"])?;
    let text = String::from_utf8_lossy(&out.stdout).into_owned();
    // "<mode> <oid> <stage>\t<path>\0"
    let mut stages: BTreeMap<String, [bool; 3]> = BTreeMap::new();
    for rec in text.split('\0').filter(|r| !r.is_empty()) {
        let Some((meta, path)) = rec.split_once('\t') else { continue };
        let stage: usize = meta.split_whitespace().nth(2).and_then(|s| s.parse().ok()).unwrap_or(0);
        if (1..=3).contains(&stage) {
            stages.entry(path.to_string()).or_insert([false; 3])[stage - 1] = true;
        }
    }
    let mut files = Vec::new();
    for (path, [b, o, t]) in stages {
        let binary = [2u8, 3, 1]
            .iter()
            .filter_map(|s| stage_blob(repo, *s, &path).ok().flatten())
            .any(|blob| is_binary(&blob));
        files.push(ConflictFile { code: code_for(b, o, t).into(), path, has_base: b, has_ours: o, has_theirs: t, binary });
    }
    Ok(files)
}

fn read_trimmed(p: std::path::PathBuf) -> Option<String> {
    std::fs::read_to_string(p).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

fn short_ref(repo: &Repo, oid: &str) -> String {
    // 优先显示分支名，其次短哈希
    repo.exec(&["name-rev", "--name-only", "--no-undefined", "--exclude=tags/*", oid], &RunOpts::read())
        .ok()
        .filter(|o| o.code == 0)
        .map(|o| o.trimmed())
        .filter(|s| !s.is_empty() && !s.contains('~') && !s.contains('^'))
        .unwrap_or_else(|| oid.chars().take(7).collect())
}

pub fn context(repo: &Repo) -> AppResult<ConflictContext> {
    let (op, _) = operation(repo);
    let dir = repo.git_dir()?;
    let current = super::branch::current(repo).unwrap_or_else(|| "HEAD".into());
    let (ours_label, theirs_label) = match op {
        Some(RepoOperation::Rebase) => {
            let onto = read_trimmed(dir.join("rebase-merge/onto")).or_else(|| read_trimmed(dir.join("rebase-apply/onto")));
            let head_name = read_trimmed(dir.join("rebase-merge/head-name"))
                .or_else(|| read_trimmed(dir.join("rebase-apply/head-name")))
                .map(|s| s.trim_start_matches("refs/heads/").to_string());
            let stopped = read_trimmed(dir.join("rebase-merge/stopped-sha")).or_else(|| read_trimmed(dir.join("REBASE_HEAD")));
            (
                onto.map(|o| short_ref(repo, &o)).unwrap_or_else(|| "onto".into()),
                match (head_name, stopped) {
                    (Some(h), Some(s)) => format!("{} ({})", h, s.chars().take(7).collect::<String>()),
                    (Some(h), None) => h,
                    (None, Some(s)) => s.chars().take(7).collect(),
                    _ => "HEAD".into(),
                },
            )
        }
        Some(RepoOperation::Merge) => (
            current,
            read_trimmed(dir.join("MERGE_HEAD"))
                .and_then(|s| s.lines().next().map(String::from))
                .map(|o| short_ref(repo, &o))
                .unwrap_or_else(|| "MERGE_HEAD".into()),
        ),
        Some(RepoOperation::CherryPick) => (
            current,
            read_trimmed(dir.join("CHERRY_PICK_HEAD")).map(|o| o.chars().take(7).collect()).unwrap_or_default(),
        ),
        Some(RepoOperation::Revert) => (
            current,
            read_trimmed(dir.join("REVERT_HEAD")).map(|o| format!("revert {}", o.chars().take(7).collect::<String>())).unwrap_or_default(),
        ),
        None => (current, "stash".into()),
    };
    Ok(ConflictContext { operation: op, ours_label, theirs_label, files: list(repo)? })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeData {
    pub path: String,
    pub base: Option<String>,
    pub ours: Option<String>,
    pub theirs: Option<String>,
    pub blocks: Vec<MergeBlock>,
    /// 工作区文件中仍有冲突标记以外的手工改动时为 true（specs/05 第 2.3 节）
    pub worktree_edited: bool,
    pub eol: String,
}

/// 三栏合并数据（X-03）
pub fn load(repo: &Repo, path: &str) -> AppResult<MergeData> {
    let base = stage_blob(repo, 1, path)?;
    let ours = stage_blob(repo, 2, path)?;
    let theirs = stage_blob(repo, 3, path)?;
    if ours.is_none() && theirs.is_none() {
        return Err(AppError::new("conflict.notConflicted").param("path", path));
    }
    if [&base, &ours, &theirs].iter().any(|b| b.as_ref().map(|x| is_binary(x)).unwrap_or(false)) {
        return Err(AppError::new("conflict.binary").param("path", path));
    }
    let to_s = |b: &Option<Vec<u8>>| b.as_ref().map(|x| String::from_utf8_lossy(x).into_owned());
    let (bs, os, ts) = (to_s(&base), to_s(&ours), to_s(&theirs));
    let eol = if os.as_deref().unwrap_or("").contains("\r\n") || ts.as_deref().unwrap_or("").contains("\r\n") { "\r\n" } else { "\n" };
    let bl = split_lines(bs.as_deref().unwrap_or(""));
    let ol = split_lines(os.as_deref().unwrap_or(""));
    let tl = split_lines(ts.as_deref().unwrap_or(""));
    let blocks = merge_blocks(&bl, &ol, &tl);

    let wt = std::fs::read_to_string(repo.join(path)?).unwrap_or_default();
    let has_markers = wt.lines().any(|l| l.starts_with("<<<<<<<")) && wt.lines().any(|l| l.starts_with(">>>>>>>"));
    let worktree_edited = !wt.is_empty() && !has_markers && Some(wt.as_str()) != os.as_deref() && Some(wt.as_str()) != ts.as_deref();

    Ok(MergeData { path: path.to_string(), base: bs, ours: os, theirs: ts, blocks, worktree_edited, eol: eol.into() })
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Side {
    Ours,
    Theirs,
}

/// 整文件接受我方/对方（X-02）。一侧已删除时，接受该侧即删除文件。
pub fn accept(repo: &Repo, paths: &[String], side: Side) -> AppResult<()> {
    let files = list(repo)?;
    for p in paths {
        let f = files.iter().find(|f| &f.path == p).ok_or_else(|| AppError::new("conflict.notConflicted").param("path", p))?;
        let present = match side {
            Side::Ours => f.has_ours,
            Side::Theirs => f.has_theirs,
        };
        if present {
            let flag = if side == Side::Ours { "--ours" } else { "--theirs" };
            repo.write(&["checkout", flag, "--", p.as_str()])?;
            repo.write(&["add", "--", p.as_str()])?;
        } else {
            repo.write(&["rm", "-q", "--ignore-unmatch", "--", p.as_str()])?;
        }
    }
    Ok(())
}

/// 写回合并结果并标记已解决（X-03 "应用"）。delete=true 表示解决为删除该文件。
pub fn resolve(repo: &Repo, path: &str, content: Option<&str>) -> AppResult<()> {
    let abs = repo.join(path)?;
    match content {
        Some(c) => {
            if let Some(parent) = abs.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(&abs, c.as_bytes())?;
            repo.write(&["add", "--", path])?;
        }
        None => {
            repo.write(&["rm", "-q", "--ignore-unmatch", "--", path])?;
        }
    }
    Ok(())
}
