//! 同步规则引擎（specs/03；M-03 ~ M-05）。
//!
//! - 规则匹配：精确名优先于通配；同为通配按 order（小者优先）。
//! - `${branch}` 替换为本地分支名。
//! - 计划（plan）：对每个本地分支展开目标，计算 ahead/behind、远端分支是否存在、remote 是否缺失。
//! - 执行（run）：pull 目标先 fetch + 集成，push 目标逐个推送，互不阻塞，统一汇总结果。

use crate::error::{AppError, AppResult};
use crate::git::branch::{conflict_or_ok, set_upstream_config};
use crate::git::parse::{BranchInfo, BranchKind};
use crate::git::runner::{CancelToken, ProgressFn, RunOpts};
use crate::git::sync::PullStrategy;
use crate::git::{check_arg, Repo};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SyncDirection {
    Push,
    Pull,
    Both,
}

impl SyncDirection {
    pub fn as_str(&self) -> &'static str {
        match self {
            SyncDirection::Push => "push",
            SyncDirection::Pull => "pull",
            SyncDirection::Both => "both",
        }
    }
    pub fn parse(s: &str) -> Self {
        match s {
            "pull" => SyncDirection::Pull,
            "both" => SyncDirection::Both,
            _ => SyncDirection::Push,
        }
    }
    pub fn pushes(&self) -> bool {
        matches!(self, SyncDirection::Push | SyncDirection::Both)
    }
    pub fn pulls(&self) -> bool {
        matches!(self, SyncDirection::Pull | SyncDirection::Both)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SyncTarget {
    pub id: String,
    /// 已存在的 remote 名；与 url 二选一
    pub remote: Option<String>,
    /// 临时目标 URL（不必加为 remote）
    pub url: Option<String>,
    /// 支持 ${branch}
    pub remote_branch: String,
    pub direction: SyncDirection,
    /// 仅 push 有效，使用 --force-with-lease
    pub force: bool,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SyncRule {
    pub id: String,
    pub repo_id: String,
    /// 精确名 "main" 或通配 "feature/*"
    pub branch_pattern: String,
    pub targets: Vec<SyncTarget>,
    pub primary_target_id: Option<String>,
    pub order: i64,
}

impl SyncRule {
    pub fn is_wildcard(&self) -> bool {
        self.branch_pattern.contains(['*', '?'])
    }
    pub fn primary(&self) -> Option<&SyncTarget> {
        let id = self.primary_target_id.as_ref()?;
        self.targets.iter().find(|t| &t.id == id)
    }
}

/// 通配匹配：`*` 匹配除 `/` 外任意字符，`**` 匹配任意字符（含 `/`），`?` 匹配单个非 `/` 字符。
/// 例外：模式以 `/*` 结尾时匹配其下任意层级（`feature/*` 匹配 `feature/a/b`），符合用户直觉。
pub fn glob_match(pattern: &str, name: &str) -> bool {
    let pattern = if let Some(prefix) = pattern.strip_suffix("/*") {
        if !prefix.contains(['*', '?']) {
            return name.len() > prefix.len() + 1 && name.starts_with(prefix) && name.as_bytes()[prefix.len()] == b'/';
        }
        pattern
    } else {
        pattern
    };
    fn rec(p: &[char], n: &[char]) -> bool {
        match (p.first(), n.first()) {
            (None, None) => true,
            (None, Some(_)) => false,
            (Some('*'), _) => {
                let double = p.get(1) == Some(&'*');
                let rest = if double { &p[2..] } else { &p[1..] };
                for i in 0..=n.len() {
                    if rec(rest, &n[i..]) {
                        return true;
                    }
                    if i < n.len() && !double && n[i] == '/' {
                        return false;
                    }
                }
                false
            }
            (Some('?'), Some(c)) => *c != '/' && rec(&p[1..], &n[1..]),
            (Some(a), Some(b)) => a == b && rec(&p[1..], &n[1..]),
            (Some(_), None) => false,
        }
    }
    let p: Vec<char> = pattern.chars().collect();
    let n: Vec<char> = name.chars().collect();
    rec(&p, &n)
}

pub fn rule_matches(rule: &SyncRule, branch: &str) -> bool {
    if rule.is_wildcard() {
        glob_match(&rule.branch_pattern, branch)
    } else {
        rule.branch_pattern == branch
    }
}

/// 按优先级返回匹配某分支的规则：第一个为生效规则，其余为被覆盖规则
pub fn matching_rules<'a>(rules: &'a [SyncRule], branch: &str) -> Vec<&'a SyncRule> {
    let mut m: Vec<&SyncRule> = rules.iter().filter(|r| rule_matches(r, branch)).collect();
    m.sort_by(|a, b| a.is_wildcard().cmp(&b.is_wildcard()).then(a.order.cmp(&b.order)));
    m
}

pub fn expand_branch(template: &str, branch: &str) -> String {
    template.replace("${branch}", branch)
}

// ======================= 计划 =======================

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannedTarget {
    pub target_id: String,
    pub rule_id: String,
    pub remote: Option<String>,
    pub url: Option<String>,
    /// 展开 ${branch} 后的远端分支名
    pub remote_branch: String,
    pub direction: SyncDirection,
    pub force: bool,
    pub enabled: bool,
    pub primary: bool,
    /// 规则引用的 remote 已被删除（specs/03 第 7 节）
    pub remote_missing: bool,
    /// refs/remotes/<remote>/<branch> 不存在；推送时将新建远端分支。URL 目标为 None（未知）
    pub remote_branch_exists: Option<bool>,
    /// 本地领先（将推送的提交数）
    pub ahead: Option<u32>,
    /// 远端领先
    pub behind: Option<u32>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum UpstreamState {
    /// 无规则或规则无 primary
    NotManaged,
    /// git upstream 与 primary target 一致
    Consistent,
    /// 不一致（例如命令行改了 upstream）
    Mismatch,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchMapping {
    pub branch: String,
    pub is_head: bool,
    pub upstream: Option<String>,
    pub upstream_remote: Option<String>,
    pub upstream_branch: Option<String>,
    pub upstream_gone: bool,
    pub ahead: u32,
    pub behind: u32,
    pub rule_id: Option<String>,
    pub rule_pattern: Option<String>,
    pub overridden_rule_ids: Vec<String>,
    pub targets: Vec<PlannedTarget>,
    pub upstream_state: UpstreamState,
}

fn rev_exists(repo: &Repo, r: &str) -> bool {
    repo.exec(&["rev-parse", "--verify", "-q", r], &RunOpts::read())
        .map(|o| o.code == 0)
        .unwrap_or(false)
}

fn count(repo: &Repo, range: &str) -> Option<u32> {
    repo.exec(&["rev-list", "--count", range], &RunOpts::read())
        .ok()
        .filter(|o| o.code == 0)
        .and_then(|o| o.trimmed().parse().ok())
}

/// 映射总览：本地分支 × upstream × 规则目标 × ahead/behind（M-03）
pub fn mapping(repo: &Repo, branches: &[BranchInfo], rules: &[SyncRule]) -> AppResult<Vec<BranchMapping>> {
    let remotes = repo.remotes()?;
    let mut out = Vec::new();
    for b in branches.iter().filter(|b| b.kind == BranchKind::Local) {
        let matched = matching_rules(rules, &b.name);
        let rule = matched.first().copied();
        let mut targets = Vec::new();
        if let Some(rule) = rule {
            for t in &rule.targets {
                targets.push(plan_target(repo, &remotes, rule, t, &b.name));
            }
        }
        let upstream_state = match rule.and_then(|r| r.primary()) {
            None => UpstreamState::NotManaged,
            Some(p) => {
                let rb = expand_branch(&p.remote_branch, &b.name);
                if p.remote.is_some()
                    && b.upstream_remote.as_deref() == p.remote.as_deref()
                    && b.upstream_branch.as_deref() == Some(rb.as_str())
                {
                    UpstreamState::Consistent
                } else {
                    UpstreamState::Mismatch
                }
            }
        };
        out.push(BranchMapping {
            branch: b.name.clone(),
            is_head: b.is_head,
            upstream: b.upstream.clone(),
            upstream_remote: b.upstream_remote.clone(),
            upstream_branch: b.upstream_branch.clone(),
            upstream_gone: b.upstream_gone,
            ahead: b.ahead,
            behind: b.behind,
            rule_id: rule.map(|r| r.id.clone()),
            rule_pattern: rule.map(|r| r.branch_pattern.clone()),
            overridden_rule_ids: matched.iter().skip(1).map(|r| r.id.clone()).collect(),
            targets,
            upstream_state,
        });
    }
    Ok(out)
}

fn plan_target(repo: &Repo, remotes: &[String], rule: &SyncRule, t: &SyncTarget, branch: &str) -> PlannedTarget {
    let rb = expand_branch(&t.remote_branch, branch);
    let remote_missing = t.remote.as_ref().map(|r| !remotes.contains(r)).unwrap_or(false);
    let (exists, ahead, behind) = match &t.remote {
        Some(r) if !remote_missing => {
            let tracking = format!("refs/remotes/{}/{}", r, rb);
            let local = format!("refs/heads/{}", branch);
            if rev_exists(repo, &tracking) {
                (
                    Some(true),
                    count(repo, &format!("{}..{}", tracking, local)),
                    count(repo, &format!("{}..{}", local, tracking)),
                )
            } else {
                // 远端分支不存在：将推送所有远端都没有的提交
                let n = repo
                    .exec(&["rev-list", "--count", local.as_str(), "--not", "--remotes"], &RunOpts::read())
                    .ok()
                    .filter(|o| o.code == 0)
                    .and_then(|o| o.trimmed().parse().ok());
                (Some(false), n, Some(0))
            }
        }
        _ => (None, None, None),
    };
    PlannedTarget {
        target_id: t.id.clone(),
        rule_id: rule.id.clone(),
        remote: t.remote.clone(),
        url: t.url.clone(),
        remote_branch: rb,
        direction: t.direction,
        force: t.force,
        enabled: t.enabled,
        primary: rule.primary_target_id.as_deref() == Some(t.id.as_str()),
        remote_missing,
        remote_branch_exists: exists,
        ahead,
        behind,
    }
}

// ======================= 执行 =======================

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TargetOutcome {
    Success,
    UpToDate,
    Rejected,
    AuthFailed,
    Network,
    Conflict,
    Skipped,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetResult {
    pub branch: String,
    pub target_id: String,
    pub remote: Option<String>,
    pub url: Option<String>,
    pub remote_branch: String,
    /// "pull" 或 "push"
    pub action: String,
    pub outcome: TargetOutcome,
    pub error: Option<AppError>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    pub results: Vec<TargetResult>,
    /// pull 阶段产生冲突，仓库进入合并/变基中
    pub conflict: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncItem {
    pub branch: String,
    pub target_id: String,
    /// "push" / "pull"
    pub action: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncRunReq {
    /// 要同步的分支；None 表示所有有规则的本地分支
    pub branches: Option<Vec<String>>,
    /// 只执行这些目标（重试失败项时使用）；None 表示所有启用目标
    pub target_ids: Option<Vec<String>>,
    /// 精确指定要执行的 (分支, 目标, 动作)；设置后优先于 branches / target_ids，
    /// 用于预览中只勾选了双向目标的某一个方向
    #[serde(default)]
    pub items: Option<Vec<SyncItem>>,
    #[serde(default)]
    pub pull_strategy: PullStrategy,
    /// 用户在预览中确认过的 force 目标；未确认的 force 目标按普通推送执行
    #[serde(default)]
    pub confirmed_force: Vec<String>,
}

fn outcome_of(e: &AppError) -> TargetOutcome {
    match e.code.as_str() {
        "git.nonFastForward" => TargetOutcome::Rejected,
        "git.authFailed" => TargetOutcome::AuthFailed,
        "git.network" => TargetOutcome::Network,
        "git.conflict" => TargetOutcome::Conflict,
        "task.cancelled" => TargetOutcome::Cancelled,
        _ => TargetOutcome::Failed,
    }
}

/// 执行同步（M-05）。每个目标独立执行，一个失败不影响其他目标。
pub fn run(
    repo: &Repo,
    branches: &[BranchInfo],
    rules: &[SyncRule],
    req: &SyncRunReq,
    cancel: &CancelToken,
    progress: &ProgressFn,
) -> AppResult<SyncReport> {
    let current = crate::git::branch::current(repo);
    let map = mapping(repo, branches, rules)?;
    let selected: Vec<&BranchMapping> = map
        .iter()
        .filter(|m| m.rule_id.is_some())
        .filter(|m| match &req.items {
            Some(items) => items.iter().any(|i| i.branch == m.branch),
            None => req.branches.as_ref().map(|bs| bs.contains(&m.branch)).unwrap_or(true),
        })
        .collect();
    if selected.is_empty() && current.is_none() && req.branches.is_none() {
        return Err(AppError::new("sync.detachedHead"));
    }

    let mut results = Vec::new();
    let mut conflict = false;
    let wanted = |branch: &str, t: &PlannedTarget, action: &str| {
        if !t.enabled {
            return false;
        }
        if let Some(items) = &req.items {
            return items.iter().any(|i| i.branch == branch && i.target_id == t.target_id && i.action == action);
        }
        req.target_ids.as_ref().map(|ids| ids.contains(&t.target_id)).unwrap_or(true)
    };
    let opts = RunOpts { cancel: Some(cancel.clone()), redact_stdout: true, progress: Some(progress.clone()), ..Default::default() };

    for m in &selected {
        // ---------- 1. pull / both 目标：fetch → 计算 behind → 集成 ----------
        for t in m.targets.iter().filter(|t| t.direction.pulls() && wanted(&m.branch, t, "pull")) {
            let mut res = TargetResult {
                branch: m.branch.clone(),
                target_id: t.target_id.clone(),
                remote: t.remote.clone(),
                url: t.url.clone(),
                remote_branch: t.remote_branch.clone(),
                action: "pull".into(),
                outcome: TargetOutcome::Success,
                error: None,
            };
            if cancel.is_cancelled() {
                res.outcome = TargetOutcome::Cancelled;
                results.push(res);
                continue;
            }
            if t.remote_missing {
                res.outcome = TargetOutcome::Skipped;
                res.error = Some(AppError::new("sync.remoteMissing").param("remote", t.remote.clone().unwrap_or_default()));
                results.push(res);
                continue;
            }
            let src = t.remote.clone().or(t.url.clone()).unwrap_or_default();
            let fetched = (|| -> AppResult<TargetOutcome> {
                check_arg("remote", &src)?;
                check_arg("branch", &t.remote_branch)?;
                let refspec = match &t.remote {
                    // 更新远端跟踪分支
                    Some(r) => format!("+refs/heads/{0}:refs/remotes/{1}/{0}", t.remote_branch, r),
                    None => format!("refs/heads/{}", t.remote_branch),
                };
                repo.run_with(&["fetch", "--progress", src.as_str(), refspec.as_str()], &opts)?;
                let theirs = match &t.remote {
                    Some(r) => format!("refs/remotes/{}/{}", r, t.remote_branch),
                    None => "FETCH_HEAD".to_string(),
                };
                let local = format!("refs/heads/{}", m.branch);
                let behind = count(repo, &format!("{}..{}", local, theirs)).unwrap_or(0);
                if behind == 0 {
                    return Ok(TargetOutcome::UpToDate);
                }
                if current.as_deref() == Some(m.branch.as_str()) {
                    let out = match req.pull_strategy {
                        PullStrategy::Rebase => repo.exec(&["rebase", theirs.as_str()], &RunOpts::literal())?,
                        PullStrategy::FfOnly => repo.exec(&["merge", "--ff-only", theirs.as_str()], &RunOpts::literal())?,
                        PullStrategy::Merge => repo.exec(&["merge", "--no-edit", theirs.as_str()], &RunOpts::literal())?,
                    };
                    let r = conflict_or_ok(repo, out)?;
                    if r.conflicts {
                        return Err(AppError::new("git.conflict").detail(r.output));
                    }
                    Ok(TargetOutcome::Success)
                } else {
                    // 非当前分支：只允许快进更新，不能合并
                    let ahead = count(repo, &format!("{}..{}", theirs, local)).unwrap_or(0);
                    if ahead > 0 {
                        return Err(AppError::new("sync.notFastForwardLocal").param("branch", &m.branch));
                    }
                    let oid = repo.read(&["rev-parse", theirs.as_str()])?.trimmed();
                    repo.write(&["update-ref", local.as_str(), oid.as_str()])?;
                    Ok(TargetOutcome::Success)
                }
            })();
            match fetched {
                Ok(o) => res.outcome = o,
                Err(e) => {
                    res.outcome = outcome_of(&e);
                    if res.outcome == TargetOutcome::Conflict {
                        conflict = true;
                    }
                    res.error = Some(e);
                }
            }
            results.push(res);
            if conflict {
                // 冲突时中断，进入冲突解决（specs/03 第 3 节）
                return Ok(SyncReport { results, conflict });
            }
        }

        // ---------- 2. push / both 目标：逐个推送，互不阻塞 ----------
        for t in m.targets.iter().filter(|t| t.direction.pushes() && wanted(&m.branch, t, "push")) {
            let mut res = TargetResult {
                branch: m.branch.clone(),
                target_id: t.target_id.clone(),
                remote: t.remote.clone(),
                url: t.url.clone(),
                remote_branch: t.remote_branch.clone(),
                action: "push".into(),
                outcome: TargetOutcome::Success,
                error: None,
            };
            if cancel.is_cancelled() {
                res.outcome = TargetOutcome::Cancelled;
                results.push(res);
                continue;
            }
            if t.remote_missing {
                res.outcome = TargetOutcome::Skipped;
                res.error = Some(AppError::new("sync.remoteMissing").param("remote", t.remote.clone().unwrap_or_default()));
                results.push(res);
                continue;
            }
            let dest = t.remote.clone().or(t.url.clone()).unwrap_or_default();
            let force = t.force && req.confirmed_force.contains(&t.target_id);
            let pushed = (|| -> AppResult<TargetOutcome> {
                check_arg("remote", &dest)?;
                check_arg("branch", &t.remote_branch)?;
                let mut args: Vec<String> = vec!["push".into(), "--progress".into(), "--porcelain".into()];
                if force {
                    args.push("--force-with-lease".into());
                }
                args.push(dest.clone());
                args.push(format!("refs/heads/{}:refs/heads/{}", m.branch, t.remote_branch));
                let out = repo.run_with(&args, &opts)?;
                // porcelain 输出中 '=' 表示已是最新
                let up_to_date = out.text().lines().any(|l| l.starts_with("=\t"));
                Ok(if up_to_date { TargetOutcome::UpToDate } else { TargetOutcome::Success })
            })();
            match pushed {
                Ok(o) => res.outcome = o,
                Err(e) => {
                    res.outcome = outcome_of(&e);
                    res.error = Some(e);
                }
            }
            results.push(res);
        }
    }
    Ok(SyncReport { results, conflict })
}

/// 规则保存时把 primary target 写入 git upstream（specs/03 第 2 节）
pub fn apply_primary_upstream(repo: &Repo, rule: &SyncRule, branches: &[BranchInfo]) -> AppResult<Vec<String>> {
    let Some(p) = rule.primary() else { return Ok(Vec::new()) };
    let Some(remote) = &p.remote else { return Ok(Vec::new()) };
    let mut updated = Vec::new();
    for b in branches.iter().filter(|b| b.kind == BranchKind::Local && rule_matches(rule, &b.name)) {
        let rb = expand_branch(&p.remote_branch, &b.name);
        if b.upstream_remote.as_deref() != Some(remote.as_str()) || b.upstream_branch.as_deref() != Some(rb.as_str()) {
            set_upstream_config(repo, &b.name, remote, &rb)?;
            updated.push(b.name.clone());
        }
    }
    Ok(updated)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(id: &str, pattern: &str, order: i64) -> SyncRule {
        SyncRule {
            id: id.into(),
            repo_id: "r".into(),
            branch_pattern: pattern.into(),
            targets: vec![],
            primary_target_id: None,
            order,
        }
    }

    #[test]
    fn globbing() {
        assert!(glob_match("feature/*", "feature/login"));
        assert!(glob_match("feature/*", "feature/a/b"));
        assert!(!glob_match("feature/*", "feature"));
        assert!(!glob_match("feature/*", "featurex/a"));
        assert!(glob_match("release-*", "release-1.0"));
        assert!(!glob_match("*", "a/b"));
        assert!(glob_match("**", "a/b"));
        assert!(glob_match("hotfix/?", "hotfix/1"));
        assert!(!glob_match("hotfix/?", "hotfix/12"));
        assert!(glob_match("*/x", "a/x"));
    }

    #[test]
    fn priority() {
        let rules = vec![rule("w2", "feature/*", 20), rule("w1", "*", 10), rule("exact", "main", 99), rule("w0", "f*", 5)];
        let m: Vec<&str> = matching_rules(&rules, "main").iter().map(|r| r.id.as_str()).collect();
        assert_eq!(m, vec!["exact", "w1"]);
        let m: Vec<&str> = matching_rules(&rules, "feature/a").iter().map(|r| r.id.as_str()).collect();
        assert_eq!(m, vec!["w2"]);
        assert!(matching_rules(&rules, "x/y").is_empty());
    }

    #[test]
    fn expand() {
        assert_eq!(expand_branch("${branch}", "feature/x"), "feature/x");
        assert_eq!(expand_branch("mirror/${branch}", "main"), "mirror/main");
        assert_eq!(expand_branch("main", "dev"), "main");
    }
}
