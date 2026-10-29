//! Remote 管理（M-01）。URL 中内嵌的凭据在写入 .git/config 前剥离并转存钥匙串（specs/03 第 5 节）。

use super::runner::RunOpts;
use super::{check_arg, Repo};
use crate::error::{AppError, AppResult};
use crate::security;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteInput {
    pub name: String,
    pub fetch_url: String,
    /// 为空表示与 fetch URL 相同
    #[serde(default)]
    pub push_urls: Vec<String>,
}

/// remote 名称规则与 git 一致：可作为 refname 片段
pub fn validate_remote_name(repo: &Repo, name: &str) -> AppResult<()> {
    check_arg("remote", name)?;
    if name.contains(char::is_whitespace) {
        return Err(AppError::new("remote.invalidName").param("name", name));
    }
    let probe = format!("refs/remotes/{}/x", name);
    let out = repo.exec(&["check-ref-format", probe.as_str()], &RunOpts::read())?;
    if out.code != 0 {
        return Err(AppError::new("remote.invalidName").param("name", name));
    }
    Ok(())
}

/// 剥离凭据后返回可写入配置的 URL
fn clean_url(url: &str) -> AppResult<String> {
    let url = url.trim();
    check_arg("url", url)?;
    let s = security::strip_url_credentials(url);
    if let (Some(u), Some(p)) = (&s.username, &s.password) {
        if let Some(key) = security::host_key(&s.url) {
            security::save_credential(&key, u, p)?;
        }
    }
    Ok(s.url)
}

fn set_push_urls(repo: &Repo, name: &str, urls: &[String]) -> AppResult<()> {
    let key = format!("remote.{}.pushurl", name);
    // --unset-all 在不存在时返回 5，忽略
    let _ = repo.exec(&["config", "--unset-all", key.as_str()], &RunOpts::literal())?;
    for u in urls.iter().map(|u| u.trim()).filter(|u| !u.is_empty()) {
        let cleaned = clean_url(u)?;
        repo.write(&["config", "--add", key.as_str(), cleaned.as_str()])?;
    }
    Ok(())
}

pub fn add(repo: &Repo, input: &RemoteInput) -> AppResult<()> {
    validate_remote_name(repo, &input.name)?;
    if repo.remotes()?.iter().any(|r| r == &input.name) {
        return Err(AppError::new("remote.exists").param("name", &input.name));
    }
    let url = clean_url(&input.fetch_url)?;
    repo.write(&["remote", "add", input.name.as_str(), url.as_str()])?;
    set_push_urls(repo, &input.name, &input.push_urls)
}

/// 编辑：可改名、改 fetch URL、改 push URL 列表
pub fn update(repo: &Repo, old_name: &str, input: &RemoteInput) -> AppResult<()> {
    check_arg("remote", old_name)?;
    if old_name != input.name {
        validate_remote_name(repo, &input.name)?;
        repo.write(&["remote", "rename", old_name, input.name.as_str()])?;
    }
    let url = clean_url(&input.fetch_url)?;
    repo.write(&["remote", "set-url", input.name.as_str(), url.as_str()])?;
    set_push_urls(repo, &input.name, &input.push_urls)
}

pub fn remove(repo: &Repo, name: &str) -> AppResult<()> {
    check_arg("remote", name)?;
    repo.write(&["remote", "remove", name])?;
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteTestResult {
    pub ok: bool,
    /// 远端分支数量（ls-remote --heads）
    pub heads: u32,
    pub error: Option<AppError>,
}

/// 测试连通性：git ls-remote --heads（走正常的凭据流程，不会弹出终端输入）
pub fn test(repo: &Repo, name_or_url: &str, cancel: &super::runner::CancelToken) -> AppResult<RemoteTestResult> {
    check_arg("remote", name_or_url)?;
    let opts = RunOpts { cancel: Some(cancel.clone()), read_only: true, ..Default::default() };
    match repo.run_with(&["ls-remote", "--heads", name_or_url], &opts) {
        Ok(out) => Ok(RemoteTestResult {
            ok: true,
            heads: out.text().lines().filter(|l| !l.trim().is_empty()).count() as u32,
            error: None,
        }),
        Err(e) if e.code == "task.cancelled" => Err(e),
        Err(e) => Ok(RemoteTestResult { ok: false, heads: 0, error: Some(e) }),
    }
}
