//! 分支（B-01 ~ B-05、B-07）与身份（T-02）。

use super::parse::{parse_branches, BranchInfo, BranchKind, BRANCH_FORMAT};
use super::runner::RunOpts;
use super::status::status;
use super::{check_arg, Repo};
use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};

pub fn list(repo: &Repo) -> AppResult<Vec<BranchInfo>> {
    let remotes = repo.remotes()?;
    let fmt = format!("--format={}", BRANCH_FORMAT);
    let out = repo.read(&["for-each-ref", fmt.as_str(), "--sort=refname", "refs/heads", "refs/remotes"])?;
    Ok(parse_branches(&out.text(), &remotes))
}

pub fn validate_name(repo: &Repo, name: &str) -> AppResult<()> {
    check_arg("branch", name)?;
    let out = repo.exec(&["check-ref-format", "--branch", name], &RunOpts::read())?;
    if out.code != 0 {
        return Err(AppError::new("git.invalidBranchName").param("name", name));
    }
    Ok(())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateBranchReq {
    pub name: String,
    /// 起点：分支名或提交；None 表示 HEAD
    pub start_point: Option<String>,
    #[serde(default)]
    pub checkout: bool,
    /// 立即设置 upstream，例如 Some(("origin", "feature/x"))
    pub upstream: Option<UpstreamRef>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpstreamRef {
    pub remote: String,
    pub branch: String,
}

pub fn create(repo: &Repo, req: &CreateBranchReq) -> AppResult<()> {
    validate_name(repo, &req.name)?;
    let mut args: Vec<String> = vec!["branch".into(), "--no-track".into(), req.name.clone()];
    if let Some(sp) = req.start_point.as_ref().filter(|s| !s.is_empty()) {
        check_arg("rev", sp)?;
        args.push(sp.clone());
    }
    repo.write(&args)?;
    if let Some(up) = &req.upstream {
        set_upstream_config(repo, &req.name, &up.remote, &up.branch)?;
    }
    if req.checkout {
        checkout(repo, &req.name, CheckoutMode::Normal)?;
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CheckoutMode {
    /// 有冲突的本地改动时由 git 拒绝，前端再询问用户
    Normal,
    /// 智能切换：stash → switch → stash pop
    Smart,
    /// 丢弃本地改动
    Force,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckoutResult {
    /// 智能切换后恢复 stash 产生冲突（stash 仍保留，需用户解决）
    pub stash_conflict: bool,
}

pub fn checkout(repo: &Repo, name: &str, mode: CheckoutMode) -> AppResult<CheckoutResult> {
    check_arg("branch", name)?;
    match mode {
        CheckoutMode::Normal => {
            repo.write(&["switch", "--no-guess", name])?;
            Ok(CheckoutResult { stash_conflict: false })
        }
        CheckoutMode::Force => {
            repo.write(&["switch", "--no-guess", "--discard-changes", name])?;
            Ok(CheckoutResult { stash_conflict: false })
        }
        CheckoutMode::Smart => {
            let st = status(repo, false)?;
            let dirty = st
                .files
                .iter()
                .any(|f| f.staged || (f.unstaged && f.kind != super::parse::ChangeKind::Untracked));
            if !dirty {
                return checkout(repo, name, CheckoutMode::Normal);
            }
            let msg = format!("GitManagement: smart checkout to {}", name);
            repo.write(&["stash", "push", "-m", msg.as_str()])?;
            if let Err(e) = repo.write(&["switch", "--no-guess", name]) {
                let _ = repo.write(&["stash", "pop", "--index"]);
                return Err(e);
            }
            let pop = repo.exec(&["stash", "pop", "--index"], &RunOpts::literal())?;
            if pop.code == 0 {
                return Ok(CheckoutResult { stash_conflict: false });
            }
            // --index 失败时退回普通 pop
            let pop = repo.exec(&["stash", "pop"], &RunOpts::literal())?;
            Ok(CheckoutResult { stash_conflict: pop.code != 0 })
        }
    }
}

/// 从远端分支检出（B-07）：创建同名本地分支并设置 upstream
pub fn checkout_remote(repo: &Repo, remote: &str, remote_branch: &str, local_name: Option<&str>) -> AppResult<String> {
    check_arg("remote", remote)?;
    check_arg("branch", remote_branch)?;
    let local = local_name.filter(|s| !s.is_empty()).unwrap_or(remote_branch).to_string();
    validate_name(repo, &local)?;
    let start = format!("refs/remotes/{}/{}", remote, remote_branch);
    repo.write(&["switch", "--no-track", "-c", local.as_str(), start.as_str()])?;
    set_upstream_config(repo, &local, remote, remote_branch)?;
    Ok(local)
}

pub fn rename(repo: &Repo, old: &str, new: &str) -> AppResult<()> {
    check_arg("branch", old)?;
    validate_name(repo, new)?;
    repo.write(&["branch", "-m", old, new])?;
    Ok(())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteBranchReq {
    pub name: String,
    /// 未合并分支强制删除（前端二次确认后设置）
    #[serde(default)]
    pub force: bool,
    /// 同时删除远端分支
    pub remote: Option<UpstreamRef>,
}

pub fn delete(repo: &Repo, req: &DeleteBranchReq) -> AppResult<()> {
    delete_with_opts(repo, req, &RunOpts::default())
}

pub fn delete_with_opts(repo: &Repo, req: &DeleteBranchReq, opts: &RunOpts) -> AppResult<()> {
    check_arg("branch", &req.name)?;
    let flag = if req.force { "-D" } else { "-d" };
    // Authenticate/validate the remote deletion before touching the local branch.
    if let Some(r) = &req.remote {
        check_arg("remote", &r.remote)?;
        check_arg("branch", &r.branch)?;
        let spec = format!(":refs/heads/{}", r.branch);
        repo.run_with(&["push", "--dry-run", r.remote.as_str(), spec.as_str()], opts)?;
    }
    repo.write(&["branch", flag, req.name.as_str()])?;
    if let Some(r) = &req.remote {
        check_arg("remote", &r.remote)?;
        check_arg("branch", &r.branch)?;
        let spec = format!(":refs/heads/{}", r.branch);
        repo.run_with(&["push", r.remote.as_str(), spec.as_str()], opts)?;
    }
    Ok(())
}

pub fn delete_remote_branch(repo: &Repo, remote: &str, branch: &str) -> AppResult<()> {
    delete_remote_branch_with_opts(repo, remote, branch, &RunOpts::default())
}

pub fn delete_remote_branch_with_opts(repo: &Repo, remote: &str, branch: &str, opts: &RunOpts) -> AppResult<()> {
    check_arg("remote", remote)?;
    check_arg("branch", branch)?;
    let spec = format!(":refs/heads/{}", branch);
    repo.run_with(&["push", remote, spec.as_str()], opts)?;
    Ok(())
}

/// 直接写 branch.<name>.remote/merge（M-02），远端分支尚不存在时也可设置
pub fn set_upstream_config(repo: &Repo, local: &str, remote: &str, remote_branch: &str) -> AppResult<()> {
    check_arg("branch", local)?;
    check_arg("remote", remote)?;
    check_arg("branch", remote_branch)?;
    let k_remote = format!("branch.{}.remote", local);
    let k_merge = format!("branch.{}.merge", local);
    let merge = format!("refs/heads/{}", remote_branch);
    repo.write(&["config", k_remote.as_str(), remote])?;
    repo.write(&["config", k_merge.as_str(), merge.as_str()])?;
    Ok(())
}

pub fn unset_upstream(repo: &Repo, local: &str) -> AppResult<()> {
    check_arg("branch", local)?;
    let out = repo.exec(&["branch", "--unset-upstream", local], &RunOpts::literal())?;
    if out.code != 0 && !out.stderr.contains("has no upstream") {
        return Err(super::runner::classify(&out.stderr, ""));
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum IntegrateMode {
    Merge,
    Rebase,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrateResult {
    /// 产生冲突，仓库处于合并/变基中
    pub conflicts: bool,
    pub output: String,
}

/// 合并选中分支到当前分支 / 当前分支变基到选中分支（B-05）
pub fn integrate(repo: &Repo, target: &str, mode: IntegrateMode) -> AppResult<IntegrateResult> {
    check_arg("rev", target)?;
    let out = match mode {
        IntegrateMode::Merge => repo.exec(&["merge", "--no-edit", target], &RunOpts::literal())?,
        IntegrateMode::Rebase => repo.exec(&["rebase", target], &RunOpts::literal())?,
    };
    conflict_or_ok(repo, out)
}

pub fn conflict_or_ok(repo: &Repo, out: super::runner::GitOutput) -> AppResult<IntegrateResult> {
    let output = format!("{}{}", out.text(), out.stderr);
    if out.code == 0 {
        return Ok(IntegrateResult { conflicts: false, output });
    }
    let (op, _) = super::status::operation(repo);
    if op.is_some() {
        return Ok(IntegrateResult { conflicts: true, output });
    }
    Err(super::runner::classify(&out.stderr, &out.text()))
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum OperationAction {
    Continue,
    Abort,
    Skip,
}

/// 中止/继续进行中的合并、变基、cherry-pick、revert（X-05 的基础能力）
pub fn operation_action(repo: &Repo, action: OperationAction) -> AppResult<IntegrateResult> {
    use super::status::RepoOperation as Op;
    let (op, _) = super::status::operation(repo);
    let op = op.ok_or_else(|| AppError::new("operation.none"))?;
    let verb = match op {
        Op::Merge => "merge",
        Op::Rebase => "rebase",
        Op::CherryPick => "cherry-pick",
        Op::Revert => "revert",
    };
    let flag = match action {
        OperationAction::Continue => "--continue",
        OperationAction::Abort => "--abort",
        OperationAction::Skip => "--skip",
    };
    if op == Op::Merge && action == OperationAction::Skip {
        return Err(AppError::new("operation.unsupported"));
    }
    let out = repo.exec(&[verb, flag], &RunOpts::literal())?;
    conflict_or_ok(repo, out)
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    pub name: Option<String>,
    pub email: Option<String>,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ConfigScope {
    Global,
    Local,
}

fn config_get(repo: &Repo, scope: ConfigScope, key: &str) -> Option<String> {
    let flag = match scope {
        ConfigScope::Global => "--global",
        ConfigScope::Local => "--local",
    };
    repo.exec(&["config", flag, "--get", key], &RunOpts::read())
        .ok()
        .filter(|o| o.code == 0)
        .map(|o| o.trimmed())
        .filter(|s| !s.is_empty())
}

pub fn get_identity(repo: &Repo, scope: ConfigScope) -> Identity {
    Identity {
        name: config_get(repo, scope, "user.name"),
        email: config_get(repo, scope, "user.email"),
    }
}

pub fn set_identity(repo: &Repo, scope: ConfigScope, id: &Identity) -> AppResult<()> {
    let flag = match scope {
        ConfigScope::Global => "--global",
        ConfigScope::Local => "--local",
    };
    for (key, val) in [("user.name", &id.name), ("user.email", &id.email)] {
        match val.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
            Some(v) => {
                repo.write(&["config", flag, key, v])?;
            }
            None => {
                let _ = repo.exec(&["config", flag, "--unset", key], &RunOpts::literal());
            }
        }
    }
    Ok(())
}

/// 当前分支（分离 HEAD 时为 None）
pub fn current(repo: &Repo) -> Option<String> {
    repo.exec(&["symbolic-ref", "--short", "-q", "HEAD"], &RunOpts::read())
        .ok()
        .filter(|o| o.code == 0)
        .map(|o| o.trimmed())
}

pub fn local_branches(repo: &Repo) -> AppResult<Vec<BranchInfo>> {
    Ok(list(repo)?.into_iter().filter(|b| b.kind == BranchKind::Local).collect())
}
