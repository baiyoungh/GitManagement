//! 同步：Clone（R-02）、Fetch / Pull / Push（S-01 ~ S-03）、推送预览（C-06）、Remote 基础信息。

use super::branch::{conflict_or_ok, set_upstream_config, IntegrateResult};
use super::parse::{parse_log, CommitSummary, LOG_FORMAT};
use super::runner::{CancelToken, GitRunner, ProgressFn, RunOpts};
use super::{check_arg, Repo};
use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::path::Path;

fn long_opts(cancel: &CancelToken, progress: Option<ProgressFn>) -> RunOpts {
    RunOpts {
        cancel: Some(cancel.clone()),
        progress,
        ..Default::default()
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloneReq {
    pub url: String,
    /// 目标目录（将被创建，必须不存在或为空）
    pub dest: String,
    pub branch: Option<String>,
    pub depth: Option<u32>,
    /// 可选的显示名称；留空时使用目标目录名
    pub name: Option<String>,
}

pub fn clone(git: &GitRunner, req: &CloneReq, cancel: &CancelToken, progress: Option<ProgressFn>) -> AppResult<()> {
    check_arg("url", &req.url)?;
    let dest = Path::new(&req.dest);
    if !dest.is_absolute() {
        return Err(AppError::new("path.invalid").param("path", &req.dest));
    }
    if dest.exists() && std::fs::read_dir(dest).map(|mut d| d.next().is_some()).unwrap_or(true) {
        return Err(AppError::new("clone.destNotEmpty").param("path", &req.dest));
    }
    let parent = dest.parent().ok_or_else(|| AppError::new("path.invalid").param("path", &req.dest))?;
    std::fs::create_dir_all(parent)?;
    let mut args: Vec<String> = vec!["clone".into(), "--progress".into()];
    if let Some(b) = req.branch.as_ref().filter(|b| !b.is_empty()) {
        check_arg("branch", b)?;
        args.push("--branch".into());
        args.push(b.clone());
    }
    if let Some(d) = req.depth.filter(|d| *d > 0) {
        args.push(format!("--depth={}", d));
    }
    args.push("--".into());
    args.push(req.url.clone());
    args.push(req.dest.clone());
    git.run(parent, &args, &long_opts(cancel, progress))?;
    Ok(())
}

pub fn fetch(repo: &Repo, remote: Option<&str>, cancel: &CancelToken, progress: Option<ProgressFn>) -> AppResult<()> {
    let mut args: Vec<String> = vec!["fetch".into(), "--progress".into(), "--prune".into()];
    match remote {
        Some(r) => {
            check_arg("remote", r)?;
            args.push(r.to_string());
        }
        None => args.push("--all".into()),
    }
    repo.run_with(&args, &long_opts(cancel, progress))?;
    Ok(())
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum PullStrategy {
    #[default]
    Merge,
    Rebase,
    FfOnly,
}

pub fn pull(repo: &Repo, strategy: PullStrategy, cancel: &CancelToken, progress: Option<ProgressFn>) -> AppResult<IntegrateResult> {
    let flag = match strategy {
        PullStrategy::Merge => "--no-rebase",
        PullStrategy::Rebase => "--rebase",
        PullStrategy::FfOnly => "--ff-only",
    };
    let out = repo.exec(&["pull", "--progress", "--no-edit", flag], &long_opts(cancel, progress))?;
    conflict_or_ok(repo, out)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushReq {
    pub branch: String,
    pub remote: String,
    pub remote_branch: String,
    #[serde(default)]
    pub force: bool,
    #[serde(default)]
    pub tags: bool,
    /// 推送成功后把该目标设为 upstream（远端分支新建时常用）
    #[serde(default)]
    pub set_upstream: bool,
}

pub fn push(repo: &Repo, req: &PushReq, cancel: &CancelToken, progress: Option<ProgressFn>) -> AppResult<String> {
    check_arg("branch", &req.branch)?;
    check_arg("remote", &req.remote)?;
    check_arg("branch", &req.remote_branch)?;
    let mut args: Vec<String> = vec!["push".into(), "--progress".into(), "--porcelain".into()];
    if req.force {
        args.push("--force-with-lease".into());
    }
    if req.tags {
        args.push("--follow-tags".into());
    }
    args.push(req.remote.clone());
    args.push(format!("refs/heads/{}:refs/heads/{}", req.branch, req.remote_branch));
    let out = repo.run_with(&args, &long_opts(cancel, progress))?;
    if req.set_upstream {
        set_upstream_config(repo, &req.branch, &req.remote, &req.remote_branch)?;
    }
    Ok(format!("{}{}", out.text(), out.stderr))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PushPreview {
    pub branch: String,
    pub remote: String,
    pub remote_branch: String,
    /// 远端跟踪分支不存在 → 推送将新建远端分支
    pub new_branch: bool,
    pub commits: Vec<CommitSummary>,
    /// 远端有本地没有的提交，普通推送会被拒绝
    pub behind: u32,
    pub remotes: Vec<String>,
}

/// 推送预览：默认目标为 upstream，无 upstream 时为 origin（或首个 remote）的同名分支
pub fn push_preview(repo: &Repo, branch: Option<&str>, remote: Option<&str>, remote_branch: Option<&str>) -> AppResult<PushPreview> {
    let branch = match branch {
        Some(b) => b.to_string(),
        None => super::branch::current(repo).ok_or_else(|| AppError::new("push.detachedHead"))?,
    };
    check_arg("branch", &branch)?;
    let remotes = repo.remotes()?;
    if remotes.is_empty() {
        return Err(AppError::new("push.noRemote"));
    }
    let cfg = |key: String| {
        repo.exec(&["config", "--get", key.as_str()], &RunOpts::read())
            .ok()
            .filter(|o| o.code == 0)
            .map(|o| o.trimmed())
    };
    let up_remote = cfg(format!("branch.{}.remote", branch)).filter(|r| r != ".");
    let up_merge = cfg(format!("branch.{}.merge", branch))
        .map(|m| m.strip_prefix("refs/heads/").unwrap_or(&m).to_string());
    let remote = remote
        .map(String::from)
        .or(up_remote)
        .unwrap_or_else(|| if remotes.iter().any(|r| r == "origin") { "origin".into() } else { remotes[0].clone() });
    let remote_branch = remote_branch.map(String::from).or(up_merge).unwrap_or_else(|| branch.clone());
    check_arg("remote", &remote)?;
    check_arg("branch", &remote_branch)?;

    let tracking = format!("refs/remotes/{}/{}", remote, remote_branch);
    let new_branch = repo
        .exec(&["rev-parse", "--verify", "-q", tracking.as_str()], &RunOpts::read())?
        .code
        != 0;
    let local = format!("refs/heads/{}", branch);
    let (commits, behind) = if new_branch {
        // 新分支：列出所有远端都没有的提交（最多 200 条）
        let out = repo.read(&["log", LOG_FORMAT, "-n", "200", local.as_str(), "--not", "--remotes"])?;
        (parse_log(&out.text()), 0)
    } else {
        let range = format!("{}..{}", tracking, local);
        let out = repo.read(&["log", LOG_FORMAT, "-n", "500", range.as_str()])?;
        let back = format!("{}..{}", local, tracking);
        let behind = repo
            .read(&["rev-list", "--count", back.as_str()])?
            .trimmed()
            .parse()
            .unwrap_or(0);
        (parse_log(&out.text()), behind)
    };
    Ok(PushPreview {
        branch,
        remote,
        remote_branch,
        new_branch,
        commits,
        behind,
        remotes,
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteInfo {
    pub name: String,
    pub fetch_url: String,
    pub push_urls: Vec<String>,
}

pub fn remotes(repo: &Repo) -> AppResult<Vec<RemoteInfo>> {
    let mut out = Vec::new();
    for name in repo.remotes()? {
        let key = format!("remote.{}.url", name);
        let fetch_url = repo
            .exec(&["config", "--get", key.as_str()], &RunOpts::read())?
            .trimmed();
        let pkey = format!("remote.{}.pushurl", name);
        let push = repo.exec(&["config", "--get-all", pkey.as_str()], &RunOpts::read())?;
        out.push(RemoteInfo {
            name,
            fetch_url: crate::security::redact(&fetch_url),
            push_urls: push
                .text()
                .lines()
                .map(|s| crate::security::redact(s.trim()))
                .filter(|s| !s.is_empty())
                .collect(),
        });
    }
    Ok(out)
}
