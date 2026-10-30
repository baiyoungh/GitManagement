//! Tauri commands（前端通过 invoke 调用）。参数名在 JS 侧为 camelCase。
//!
//! 所有命令都在阻塞线程池中执行，避免 git 调用阻塞 UI；写操作按仓库加锁串行。

use crate::error::{AppError, AppResult};
use crate::git::branch::{self, CheckoutMode, CheckoutResult, ConfigScope, CreateBranchReq, DeleteBranchReq, Identity, IntegrateMode, IntegrateResult, OperationAction};
use crate::git::changes::{self, CommitRequest, CommitResult, IgnoreTarget, RollbackOpts, RollbackResult};
use crate::git::diff::{self, DiffOpts, FileDiff, Rev};
use crate::git::parse::BranchInfo;
use crate::git::runner::{detect_git, CommandLogEntry, GitRunner, RunOpts, MIN_GIT_VERSION};
use crate::git::status::{self, RepoSummary, StatusResult};
use crate::git::sync::{self, CloneReq, PullStrategy, PushPreview, PushReq, RemoteInfo};
use crate::git::Repo;
use crate::git::conflict::{self, ConflictContext, MergeData, Side};
use crate::git::log::{self, CommitDetail, LogPage, LogQuery, ResetMode};
use crate::git::remote::{self, RemoteInput, RemoteTestResult};
use crate::git::log::{BlameResult, BlobData, CommitFile, FileHistoryEntry, RefCompare, TagInfo};
use crate::git::precheck::{self, PrecheckIssue, PrecheckOpts};
use crate::git::stash::{self, StashCreateReq, StashEntry, StashFile};
use crate::storage::{Changelist, RepoGroup};
use crate::system::{self, FoundRepo, OpenTarget};
use crate::security;
use crate::storage::{Db, RepoRecord};
use crate::sync_engine::{self, BranchMapping, SyncRule, SyncRunReq, SyncTarget, TargetOutcome};
use crate::tasks::{TaskInfo, TaskManager};
use crate::watcher::WatchManager;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
#[allow(unused_imports)]
use tauri::Manager;
use tauri::{AppHandle, State};

#[derive(Clone)]
pub struct AppState {
    pub db: Arc<Db>,
    pub git: Arc<GitRunner>,
    pub tasks: Arc<TaskManager>,
    pub watcher: Arc<WatchManager>,
    pub terminals: crate::terminal::TerminalManager,
    pub allow_exit: Arc<std::sync::atomic::AtomicBool>,
    pub unsaved_files: Arc<std::sync::atomic::AtomicBool>,
}

impl AppState {
    fn record(&self, repo_id: &str) -> AppResult<RepoRecord> {
        self.db.get_repo(repo_id)
    }

    fn repo_path(&self, repo_id: &str) -> AppResult<PathBuf> {
        let r = self.record(repo_id)?;
        let p = PathBuf::from(&r.path);
        if !p.is_dir() {
            return Err(AppError::new("repo.missing").param("path", &r.path));
        }
        Ok(p)
    }

    fn read<T>(&self, repo_id: &str, f: impl FnOnce(&Repo) -> AppResult<T>) -> AppResult<T> {
        let path = self.repo_path(repo_id)?;
        f(&Repo::new(&self.git, path))
    }

    fn write<T>(&self, repo_id: &str, f: impl FnOnce(&Repo) -> AppResult<T>) -> AppResult<T> {
        let path = self.repo_path(repo_id)?;
        let lock = self.tasks.repo_lock(repo_id);
        let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
        f(&Repo::new(&self.git, path))
    }

    pub fn auto_refresh_enabled(&self, repo_id: &str) -> bool {
        let global = self.db.get_setting("autoRefresh").ok().flatten();
        let local = self.db.get_setting(&format!("autoRefresh:{}", repo_id)).ok().flatten();
        local.or(global).map(|v| v != "false").unwrap_or(true)
    }
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> AppResult<T> + Send + 'static) -> AppResult<T> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| AppError::internal(e.to_string()))?
}

#[tauri::command]
pub fn app_exit(app: AppHandle, state: State<'_, AppState>) {
    state.allow_exit.store(true, std::sync::atomic::Ordering::SeqCst);
    app.exit(0);
}

#[tauri::command]
pub fn app_set_dirty(state: State<'_, AppState>, dirty: bool) {
    state.unsaved_files.store(dirty, std::sync::atomic::Ordering::SeqCst);
}

#[tauri::command]
pub async fn files_list(state: State<'_, AppState>, repo_id: String, path: String) -> AppResult<crate::files::Directory> {
    let root = state.repo_path(&repo_id)?;
    blocking(move || crate::files::list(&root, &path)).await
}

#[tauri::command]
pub async fn files_read(state: State<'_, AppState>, repo_id: String, path: String) -> AppResult<crate::files::Document> {
    let root = state.repo_path(&repo_id)?;
    blocking(move || crate::files::read(&root, &path)).await
}

#[tauri::command]
pub async fn files_save(state: State<'_, AppState>, repo_id: String, path: String, revision: String, text: String) -> AppResult<crate::files::Document> {
    let st = state.inner().clone();
    blocking(move || {
        let root = st.repo_path(&repo_id)?;
        let lock = st.tasks.repo_lock(&repo_id);
        let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
        crate::files::save(&root, &path, &revision, &text)
    }).await
}

#[tauri::command]
pub async fn terminal_open(state: State<'_, AppState>, repo_id: String, id: String, cols: u16, rows: u16, on_event: tauri::ipc::Channel<crate::terminal::TerminalEvent>) -> AppResult<()> {
    let root = state.repo_path(&repo_id)?;
    let manager = state.terminals.clone();
    blocking(move || manager.open(id, &root, cols, rows, move |event| on_event.send(event).is_ok())).await
}

#[tauri::command]
pub async fn terminal_input(state: State<'_, AppState>, id: String, data: String) -> AppResult<()> {
    let manager = state.terminals.clone();
    blocking(move || manager.input(&id, &data)).await
}

#[tauri::command]
pub async fn terminal_resize(state: State<'_, AppState>, id: String, cols: u16, rows: u16) -> AppResult<()> {
    let manager = state.terminals.clone();
    blocking(move || manager.resize(&id, cols, rows)).await
}

#[tauri::command]
pub async fn terminal_close(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let manager = state.terminals.clone();
    blocking(move || manager.close(&id)).await
}

#[tauri::command]
pub fn terminal_ack(state: State<'_, AppState>, id: String, count: usize) {
    state.terminals.ack(&id, count);
}

fn params(pairs: &[(&str, &str)]) -> HashMap<String, String> {
    pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
}

fn normalize_root(raw: &str) -> String {
    let s = raw.trim();
    if cfg!(windows) {
        s.replace('/', "\\")
    } else {
        s.to_string()
    }
}

fn dir_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string())
}

// ======================= 应用 / 设置 =======================

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitInfo {
    pub path: String,
    pub version: Option<String>,
    pub ok: bool,
    pub min_version: String,
    pub error: Option<AppError>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub app_version: String,
    pub platform: String,
    pub git: GitInfo,
}

fn git_info(git: &GitRunner) -> GitInfo {
    let min = format!("{}.{}.{}", MIN_GIT_VERSION.0, MIN_GIT_VERSION.1, MIN_GIT_VERSION.2);
    match git.version() {
        Ok((v, raw)) => GitInfo {
            path: git.git_path().display().to_string(),
            version: Some(raw),
            ok: v >= MIN_GIT_VERSION,
            min_version: min,
            error: None,
        },
        Err(e) => GitInfo {
            path: git.git_path().display().to_string(),
            version: None,
            ok: false,
            min_version: min,
            error: Some(e),
        },
    }
}

#[tauri::command]
pub async fn app_info(app: AppHandle, state: State<'_, AppState>) -> AppResult<AppInfo> {
    let st = state.inner().clone();
    let version = app.package_info().version.to_string();
    blocking(move || {
        Ok(AppInfo {
            app_version: version,
            platform: std::env::consts::OS.to_string(),
            git: git_info(&st.git),
        })
    })
    .await
}

#[tauri::command]
pub async fn git_set_path(state: State<'_, AppState>, path: Option<String>) -> AppResult<GitInfo> {
    let st = state.inner().clone();
    blocking(move || {
        let p = path.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(String::from);
        st.db.set_setting("gitPath", p.as_deref().unwrap_or(""))?;
        st.git.set_git_path(detect_git(p.as_deref()));
        Ok(git_info(&st.git))
    })
    .await
}

#[tauri::command]
pub async fn settings_get_all(state: State<'_, AppState>) -> AppResult<HashMap<String, String>> {
    let st = state.inner().clone();
    blocking(move || st.db.all_settings()).await
}

#[tauri::command]
pub async fn settings_set(state: State<'_, AppState>, key: String, value: String) -> AppResult<()> {
    let st = state.inner().clone();
    blocking(move || st.db.set_setting(&key, &value)).await
}

#[tauri::command]
pub fn command_log_list(state: State<'_, AppState>) -> Vec<CommandLogEntry> {
    state.git.log_entries()
}

#[tauri::command]
pub fn command_log_clear(state: State<'_, AppState>) {
    state.git.clear_log()
}

// ======================= 仓库 =======================

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoView {
    #[serde(flatten)]
    pub record: RepoRecord,
    pub missing: bool,
    pub watching: bool,
}

#[tauri::command]
pub async fn repo_list(state: State<'_, AppState>) -> AppResult<Vec<RepoView>> {
    let st = state.inner().clone();
    blocking(move || {
        Ok(st
            .db
            .list_repos()?
            .into_iter()
            .map(|r| RepoView {
                missing: !Path::new(&r.path).is_dir(),
                watching: st.watcher.is_watching(&r.id),
                record: r,
            })
            .collect())
    })
    .await
}

#[tauri::command]
pub async fn repo_summary(state: State<'_, AppState>, repo_id: String) -> AppResult<RepoSummary> {
    let st = state.inner().clone();
    blocking(move || st.read(&repo_id, status::summary)).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathCheck {
    pub exists: bool,
    pub is_repo: bool,
    /// 仓库根目录（选中的是子目录时与 path 不同）
    pub root: Option<String>,
    pub registered: bool,
}

#[tauri::command]
pub async fn repo_check_path(state: State<'_, AppState>, path: String) -> AppResult<PathCheck> {
    let st = state.inner().clone();
    blocking(move || {
        let p = PathBuf::from(&path);
        if !p.is_dir() {
            return Ok(PathCheck { exists: false, is_repo: false, root: None, registered: false });
        }
        let out = st.git.exec(&p, &["rev-parse", "--show-toplevel"], &RunOpts::read())?;
        let root = if out.code == 0 { Some(normalize_root(&out.text())) } else { None };
        let registered = match &root {
            Some(r) => st.db.find_repo_by_path(r)?.is_some(),
            None => false,
        };
        Ok(PathCheck { exists: true, is_repo: root.is_some(), root, registered })
    })
    .await
}

fn register(st: &AppState, app: &AppHandle, root: &str) -> AppResult<RepoRecord> {
    if let Some(existing) = st.db.find_repo_by_path(root)? {
        return Ok(existing);
    }
    let repo = Repo::new(&st.git, root);
    let root_commit = repo.root_commit();
    // 目录移动后重新关联（specs/03 第 5 节）：同一首个提交、原路径已不存在的登记记录
    if let Some(rc) = &root_commit {
        for r in st.db.list_repos()? {
            if r.root_commit.as_deref() == Some(rc.as_str()) && !Path::new(&r.path).exists() {
                st.db.update_repo_path(&r.id, root)?;
                let rec = st.db.get_repo(&r.id)?;
                if st.auto_refresh_enabled(&rec.id) {
                    st.watcher.watch(app, &rec.id, Path::new(root));
                }
                return Ok(rec);
            }
        }
    }
    let rec = st.db.insert_repo(root, &dir_name(root), root_commit.as_deref())?;
    if st.auto_refresh_enabled(&rec.id) {
        st.watcher.watch(app, &rec.id, Path::new(root));
    }
    Ok(rec)
}

/// 添加本地仓库（R-01）。`init` 为 true 时对非仓库目录执行 git init。
#[tauri::command]
pub async fn repo_add(app: AppHandle, state: State<'_, AppState>, path: String, init: bool) -> AppResult<RepoRecord> {
    let st = state.inner().clone();
    blocking(move || {
        let p = PathBuf::from(&path);
        if !p.is_dir() {
            return Err(AppError::new("path.invalid").param("path", &path));
        }
        let mut out = st.git.exec(&p, &["rev-parse", "--show-toplevel"], &RunOpts::read())?;
        if out.code != 0 {
            if !init {
                return Err(AppError::new("repo.notARepo").param("path", &path));
            }
            st.git.run(&p, &["init"], &RunOpts::default())?;
            out = st.git.run(&p, &["rev-parse", "--show-toplevel"], &RunOpts::read())?;
        }
        register(&st, &app, &normalize_root(&out.text()))
    })
    .await
}

/// 移除登记（R-07）：只从工具中移除，不删除磁盘文件
#[tauri::command]
pub async fn repo_remove(state: State<'_, AppState>, repo_id: String) -> AppResult<()> {
    let st = state.inner().clone();
    blocking(move || {
        st.watcher.unwatch(&repo_id);
        st.db.delete_repo(&repo_id)
    })
    .await
}

#[tauri::command]
pub async fn repo_rename(state: State<'_, AppState>, repo_id: String, name: String) -> AppResult<()> {
    let st = state.inner().clone();
    blocking(move || {
        let n = name.trim();
        if n.is_empty() {
            return Err(AppError::new("arg.invalid").param("kind", "name").param("value", n));
        }
        st.db.rename_repo(&repo_id, n)
    })
    .await
}

#[tauri::command]
pub async fn repo_set_favorite(state: State<'_, AppState>, repo_id: String, favorite: bool) -> AppResult<()> {
    let st = state.inner().clone();
    blocking(move || st.db.set_favorite(&repo_id, favorite)).await
}

/// 开关单个仓库的自动刷新（R-09：大仓库可关闭）
#[tauri::command]
pub async fn repo_set_watch(app: AppHandle, state: State<'_, AppState>, repo_id: String, enabled: bool) -> AppResult<()> {
    let st = state.inner().clone();
    blocking(move || {
        st.db.set_setting(&format!("autoRefresh:{}", repo_id), if enabled { "true" } else { "false" })?;
        if enabled {
            let p = st.repo_path(&repo_id)?;
            st.watcher.watch(&app, &repo_id, &p);
        } else {
            st.watcher.unwatch(&repo_id);
        }
        Ok(())
    })
    .await
}

// ======================= 状态 / 变更 =======================

#[tauri::command]
pub async fn status_get(state: State<'_, AppState>, repo_id: String) -> AppResult<StatusResult> {
    let st = state.inner().clone();
    blocking(move || st.read(&repo_id, |r| status::status(r, true))).await
}

#[tauri::command]
pub async fn checked_get(state: State<'_, AppState>, repo_id: String) -> AppResult<HashMap<String, bool>> {
    let st = state.inner().clone();
    blocking(move || st.db.get_checked(&repo_id)).await
}

#[tauri::command]
pub async fn checked_set(
    state: State<'_, AppState>,
    repo_id: String,
    entries: HashMap<String, bool>,
    keep: Option<Vec<String>>,
) -> AppResult<()> {
    let st = state.inner().clone();
    blocking(move || {
        st.db.set_checked(&repo_id, &entries)?;
        if let Some(k) = keep {
            st.db.prune_checked(&repo_id, &k)?;
            st.db.prune_changelist_members(&repo_id, &k)?;
        }
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn diff_file(
    state: State<'_, AppState>,
    repo_id: String,
    path: String,
    old_path: Option<String>,
    left: Rev,
    right: Rev,
    opts: Option<DiffOpts>,
) -> AppResult<FileDiff> {
    let st = state.inner().clone();
    blocking(move || {
        st.read(&repo_id, |r| {
            diff::diff_file(r, &path, old_path.as_deref(), &left, &right, &opts.unwrap_or_default())
        })
    })
    .await
}

#[tauri::command]
pub async fn worktree_write(state: State<'_, AppState>, repo_id: String, path: String, content: String) -> AppResult<()> {
    let st = state.inner().clone();
    blocking(move || st.write(&repo_id, |r| changes::write_worktree_file(r, &path, &content))).await
}

#[tauri::command]
pub async fn commit_create(state: State<'_, AppState>, repo_id: String, req: CommitRequest) -> AppResult<CommitResult> {
    let st = state.inner().clone();
    blocking(move || {
        let res = st.write(&repo_id, |r| changes::commit(r, &req))?;
        let _ = st.db.add_message(&repo_id, &req.message);
        // 已提交文件的勾选记录由前端下次 checked_set(keep=…) 时清理
        Ok(res)
    })
    .await
}

#[tauri::command]
pub async fn commit_messages(state: State<'_, AppState>, repo_id: String) -> AppResult<Vec<String>> {
    let st = state.inner().clone();
    blocking(move || st.db.messages(&repo_id)).await
}

/// HEAD 提交的完整消息（Amend 时预填）；合并进行中时返回 MERGE_MSG
#[tauri::command]
pub async fn commit_head_message(state: State<'_, AppState>, repo_id: String) -> AppResult<Option<String>> {
    let st = state.inner().clone();
    blocking(move || {
        st.read(&repo_id, |r| {
            let out = r.exec(&["log", "-1", "--format=%B"], &RunOpts::read())?;
            Ok(if out.code == 0 { Some(out.text().trim_end().to_string()) } else { None })
        })
    })
    .await
}

#[tauri::command]
pub async fn commit_merge_message(state: State<'_, AppState>, repo_id: String) -> AppResult<Option<String>> {
    let st = state.inner().clone();
    blocking(move || {
        st.read(&repo_id, |r| {
            let p = r.git_dir()?.join("MERGE_MSG");
            Ok(std::fs::read_to_string(p).ok().map(|s| {
                s.lines()
                    .filter(|l| !l.starts_with('#'))
                    .collect::<Vec<_>>()
                    .join("\n")
                    .trim()
                    .to_string()
            }))
        })
    })
    .await
}

#[tauri::command]
pub async fn changes_rollback(
    state: State<'_, AppState>,
    repo_id: String,
    paths: Vec<String>,
    opts: RollbackOpts,
) -> AppResult<RollbackResult> {
    let st = state.inner().clone();
    blocking(move || st.write(&repo_id, |r| changes::rollback(r, &paths, &opts))).await
}

#[tauri::command]
pub async fn changes_add(state: State<'_, AppState>, repo_id: String, paths: Vec<String>) -> AppResult<()> {
    let st = state.inner().clone();
    blocking(move || st.write(&repo_id, |r| changes::add(r, &paths))).await
}

#[tauri::command]
pub async fn changes_ignore(state: State<'_, AppState>, repo_id: String, paths: Vec<String>, target: IgnoreTarget) -> AppResult<()> {
    let st = state.inner().clone();
    blocking(move || st.write(&repo_id, |r| changes::ignore(r, &paths, target))).await
}

// ======================= 分支 =======================

#[tauri::command]
pub async fn branch_list(state: State<'_, AppState>, repo_id: String) -> AppResult<Vec<BranchInfo>> {
    let st = state.inner().clone();
    blocking(move || st.read(&repo_id, branch::list)).await
}

#[tauri::command]
pub async fn branch_create(state: State<'_, AppState>, repo_id: String, req: CreateBranchReq) -> AppResult<()> {
    let st = state.inner().clone();
    blocking(move || st.write(&repo_id, |r| branch::create(r, &req))).await
}

#[tauri::command]
pub async fn branch_checkout(state: State<'_, AppState>, repo_id: String, name: String, mode: CheckoutMode) -> AppResult<CheckoutResult> {
    let st = state.inner().clone();
    blocking(move || st.write(&repo_id, |r| branch::checkout(r, &name, mode))).await
}

#[tauri::command]
pub async fn branch_checkout_remote(
    state: State<'_, AppState>,
    repo_id: String,
    remote: String,
    remote_branch: String,
    local_name: Option<String>,
) -> AppResult<String> {
    let st = state.inner().clone();
    blocking(move || st.write(&repo_id, |r| branch::checkout_remote(r, &remote, &remote_branch, local_name.as_deref()))).await
}

#[tauri::command]
pub async fn branch_rename(state: State<'_, AppState>, repo_id: String, old: String, new: String) -> AppResult<()> {
    let st = state.inner().clone();
    blocking(move || st.write(&repo_id, |r| branch::rename(r, &old, &new))).await
}

#[tauri::command]
pub async fn branch_delete(state: State<'_, AppState>, repo_id: String, req: DeleteBranchReq) -> AppResult<()> {
    let st = state.inner().clone();
    blocking(move || st.write(&repo_id, |r| branch::delete(r, &req))).await
}

#[tauri::command]
pub async fn branch_delete_remote(state: State<'_, AppState>, repo_id: String, remote: String, branch: String) -> AppResult<()> {
    let st = state.inner().clone();
    blocking(move || st.write(&repo_id, |r| branch::delete_remote_branch(r, &remote, &branch))).await
}

#[tauri::command]
pub async fn branch_integrate(state: State<'_, AppState>, repo_id: String, target: String, mode: IntegrateMode) -> AppResult<IntegrateResult> {
    let st = state.inner().clone();
    blocking(move || st.write(&repo_id, |r| branch::integrate(r, &target, mode))).await
}

#[tauri::command]
pub async fn branch_set_upstream(
    state: State<'_, AppState>,
    repo_id: String,
    local: String,
    remote: Option<String>,
    remote_branch: Option<String>,
) -> AppResult<()> {
    let st = state.inner().clone();
    blocking(move || {
        st.write(&repo_id, |r| match (remote, remote_branch) {
            (Some(rm), Some(rb)) => branch::set_upstream_config(r, &local, &rm, &rb),
            _ => branch::unset_upstream(r, &local),
        })
    })
    .await
}

#[tauri::command]
pub async fn operation_action(state: State<'_, AppState>, repo_id: String, action: OperationAction) -> AppResult<IntegrateResult> {
    let st = state.inner().clone();
    blocking(move || st.write(&repo_id, |r| branch::operation_action(r, action))).await
}

#[tauri::command]
pub async fn remote_list(state: State<'_, AppState>, repo_id: String) -> AppResult<Vec<RemoteInfo>> {
    let st = state.inner().clone();
    blocking(move || st.read(&repo_id, sync::remotes)).await
}

#[tauri::command]
pub async fn push_preview(
    state: State<'_, AppState>,
    repo_id: String,
    branch: Option<String>,
    remote: Option<String>,
    remote_branch: Option<String>,
) -> AppResult<PushPreview> {
    let st = state.inner().clone();
    blocking(move || {
        st.read(&repo_id, |r| sync::push_preview(r, branch.as_deref(), remote.as_deref(), remote_branch.as_deref()))
    })
    .await
}

// ======================= 身份 / 凭据 =======================

#[tauri::command]
pub async fn identity_get(state: State<'_, AppState>, repo_id: Option<String>, scope: ConfigScope) -> AppResult<Identity> {
    let st = state.inner().clone();
    blocking(move || match (&repo_id, scope) {
        (Some(id), _) => st.read(id, |r| Ok(branch::get_identity(r, scope))),
        (None, ConfigScope::Global) => Ok(branch::get_identity(&Repo::new(&st.git, std::env::temp_dir()), scope)),
        (None, ConfigScope::Local) => Err(AppError::new("arg.invalid").param("kind", "repoId").param("value", "")),
    })
    .await
}

#[tauri::command]
pub async fn identity_set(state: State<'_, AppState>, repo_id: Option<String>, scope: ConfigScope, identity: Identity) -> AppResult<()> {
    let st = state.inner().clone();
    blocking(move || match (&repo_id, scope) {
        (Some(id), _) => st.write(id, |r| branch::set_identity(r, scope, &identity)),
        (None, ConfigScope::Global) => branch::set_identity(&Repo::new(&st.git, std::env::temp_dir()), scope, &identity),
        (None, ConfigScope::Local) => Err(AppError::new("arg.invalid").param("kind", "repoId").param("value", "")),
    })
    .await
}

fn cred_key(url: &str) -> AppResult<String> {
    security::host_key(url).ok_or_else(|| AppError::new("credential.unsupportedUrl").param("url", url))
}

/// 保存 HTTPS 令牌到系统钥匙串（T-03），不落盘
#[tauri::command]
pub async fn credential_save(url: String, username: String, secret: String) -> AppResult<()> {
    blocking(move || security::save_credential(&cred_key(&url)?, username.trim(), &secret)).await
}

#[tauri::command]
pub async fn credential_delete(url: String) -> AppResult<()> {
    blocking(move || security::delete_credential(&cred_key(&url)?)).await
}

/// 只返回用户名，不把令牌返回给前端
#[tauri::command]
pub async fn credential_get_user(url: String) -> AppResult<Option<String>> {
    blocking(move || Ok(security::load_credential(&cred_key(&url)?).map(|(u, _)| u))).await
}

// ======================= 后台任务 =======================

#[tauri::command]
pub fn task_list(state: State<'_, AppState>) -> Vec<TaskInfo> {
    state.tasks.list()
}

#[tauri::command]
pub fn task_cancel(state: State<'_, AppState>, task_id: String) -> bool {
    state.tasks.cancel(&task_id)
}

#[tauri::command]
pub fn task_clear(state: State<'_, AppState>) {
    state.tasks.clear_finished()
}

/// 克隆（R-02）。URL 内嵌的令牌会先剥离并存入钥匙串，完成后自动登记。
#[tauri::command]
pub fn task_clone(app: AppHandle, state: State<'_, AppState>, req: CloneReq) -> AppResult<String> {
    let mut req = req;
    let stripped = security::strip_url_credentials(req.url.trim());
    if let (Some(u), Some(p)) = (&stripped.username, &stripped.password) {
        if let Some(key) = security::host_key(&stripped.url) {
            security::save_credential(&key, u, p)?;
        }
    }
    req.url = stripped.url;
    let st = state.inner().clone();
    let app2 = app.clone();
    let name = dir_name(&req.dest);
    let task_params = params(&[("name", name.as_str()), ("url", req.url.as_str())]);
    Ok(state.tasks.spawn(&app, None, "clone", task_params, move |cancel, progress| {
        sync::clone(&st.git, &req, cancel, Some(progress))?;
        // 用 git 给出的根目录登记，避免符号链接（如 macOS /tmp → /private/tmp）造成路径不一致
        let out = st.git.run(Path::new(&req.dest), &["rev-parse", "--show-toplevel"], &RunOpts::read())?;
        let rec = register(&st, &app2, &normalize_root(&out.text()))?;
        Ok(rec.id)
    }))
}

fn repo_task(
    app: &AppHandle,
    state: &AppState,
    repo_id: &str,
    kind: &str,
    extra: &[(&str, &str)],
    job: impl FnOnce(&Repo, &crate::git::runner::CancelToken, crate::git::runner::ProgressFn) -> AppResult<String> + Send + 'static,
) -> AppResult<String> {
    let rec = state.record(repo_id)?;
    let path = state.repo_path(repo_id)?;
    let mut p = params(extra);
    p.insert("repo".into(), rec.name.clone());
    let st = state.clone();
    Ok(state.tasks.spawn(app, Some(repo_id.to_string()), kind, p, move |cancel, progress| {
        job(&Repo::new(&st.git, path), cancel, progress)
    }))
}

#[tauri::command]
pub fn task_fetch(app: AppHandle, state: State<'_, AppState>, repo_id: String, remote: Option<String>) -> AppResult<String> {
    let label = remote.clone().unwrap_or_default();
    repo_task(&app, state.inner(), &repo_id, "fetch", &[("remote", label.as_str())], move |r, c, p| {
        sync::fetch(r, remote.as_deref(), c, Some(p))?;
        Ok(String::new())
    })
}

/// 全部仓库 Fetch（S-01），跨仓库并行受全局并发上限约束
#[tauri::command]
pub fn task_fetch_all(app: AppHandle, state: State<'_, AppState>) -> AppResult<Vec<String>> {
    let mut ids = Vec::new();
    for r in state.db.list_repos()? {
        if Path::new(&r.path).is_dir() {
            ids.push(repo_task(&app, state.inner(), &r.id, "fetch", &[("remote", "")], |repo, c, p| {
                sync::fetch(repo, None, c, Some(p))?;
                Ok(String::new())
            })?);
        }
    }
    Ok(ids)
}

#[tauri::command]
pub fn task_pull(app: AppHandle, state: State<'_, AppState>, repo_id: String, strategy: Option<PullStrategy>) -> AppResult<String> {
    let strategy = strategy.unwrap_or_default();
    repo_task(&app, state.inner(), &repo_id, "pull", &[], move |r, c, p| {
        let res = sync::pull(r, strategy, c, Some(p))?;
        if res.conflicts {
            return Err(AppError::new("git.conflict").detail(res.output));
        }
        Ok(res.output)
    })
}

// ======================= M2：Remote 管理（M-01） =======================

#[tauri::command]
pub async fn remote_add(state: State<'_, AppState>, repo_id: String, input: RemoteInput) -> AppResult<()> {
    let st = state.inner().clone();
    blocking(move || st.write(&repo_id, |r| remote::add(r, &input))).await
}

#[tauri::command]
pub async fn remote_update(state: State<'_, AppState>, repo_id: String, old_name: String, input: RemoteInput) -> AppResult<()> {
    let st = state.inner().clone();
    blocking(move || {
        st.write(&repo_id, |r| remote::update(r, &old_name, &input))?;
        if old_name != input.name {
            st.db.rename_rule_remote(&repo_id, &old_name, &input.name)?;
        }
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn remote_remove(state: State<'_, AppState>, repo_id: String, name: String) -> AppResult<()> {
    let st = state.inner().clone();
    blocking(move || st.write(&repo_id, |r| remote::remove(r, &name))).await
}

#[tauri::command]
pub async fn remote_test(state: State<'_, AppState>, repo_id: String, name: String) -> AppResult<RemoteTestResult> {
    let st = state.inner().clone();
    blocking(move || st.read(&repo_id, |r| remote::test(r, &name, &crate::git::runner::CancelToken::new()))).await
}

// ======================= M2：同步规则（M-02 ~ M-05） =======================

#[tauri::command]
pub async fn sync_rules(state: State<'_, AppState>, repo_id: String) -> AppResult<Vec<SyncRule>> {
    let st = state.inner().clone();
    blocking(move || st.db.list_rules(&repo_id)).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleSaved {
    pub rule: SyncRule,
    /// 因 primary target 而更新了 upstream 的分支
    pub upstream_updated: Vec<String>,
}

/// 保存规则；有 primary target 时同步写入 git upstream（specs/03 第 2 节）
#[tauri::command]
pub async fn sync_rule_upsert(state: State<'_, AppState>, repo_id: String, rule: SyncRule) -> AppResult<RuleSaved> {
    let st = state.inner().clone();
    blocking(move || {
        let pattern = rule.branch_pattern.trim().to_string();
        if pattern.is_empty() || pattern.starts_with('-') {
            return Err(AppError::new("sync.invalidPattern").param("pattern", &pattern));
        }
        let mut rule = rule;
        rule.repo_id = repo_id.clone();
        rule.branch_pattern = pattern;
        for t in &rule.targets {
            if t.remote.is_none() && t.url.as_deref().map(str::trim).unwrap_or("").is_empty() {
                return Err(AppError::new("sync.targetNoRemote"));
            }
            if t.remote_branch.trim().is_empty() {
                return Err(AppError::new("sync.targetNoBranch"));
            }
        }
        // URL 目标不保存凭据（specs/03 第 5 节）
        for t in rule.targets.iter_mut() {
            if let Some(u) = &t.url {
                let s = security::strip_url_credentials(u.trim());
                if let (Some(user), Some(pass), Some(key)) = (&s.username, &s.password, security::host_key(&s.url)) {
                    security::save_credential(&key, user, pass)?;
                }
                t.url = Some(s.url);
            }
        }
        let saved = st.db.upsert_rule(&rule)?;
        let updated = st.write(&repo_id, |r| {
            let branches = branch::list(r)?;
            sync_engine::apply_primary_upstream(r, &saved, &branches)
        })?;
        Ok(RuleSaved { rule: saved, upstream_updated: updated })
    })
    .await
}

#[tauri::command]
pub async fn sync_rule_delete(state: State<'_, AppState>, rule_id: String) -> AppResult<()> {
    let st = state.inner().clone();
    blocking(move || st.db.delete_rule(&rule_id)).await
}

/// 映射总览（M-03）
#[tauri::command]
pub async fn sync_mapping(state: State<'_, AppState>, repo_id: String) -> AppResult<Vec<BranchMapping>> {
    let st = state.inner().clone();
    blocking(move || {
        let rules = st.db.list_rules(&repo_id)?;
        st.read(&repo_id, |r| sync_engine::mapping(r, &branch::list(r)?, &rules))
    })
    .await
}

#[derive(Debug, Clone, Copy, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum UpstreamResolution {
    /// 以 git 配置为准：把规则的 primary 改成当前 upstream 对应的目标（不存在则新增目标）
    Git,
    /// 以规则为准：把 upstream 改回 primary target
    Rule,
}

/// 处理 upstream 与规则 primary 不一致（specs/03 第 2 节）
#[tauri::command]
pub async fn sync_resolve_upstream(state: State<'_, AppState>, repo_id: String, branch_name: String, prefer: UpstreamResolution) -> AppResult<()> {
    let st = state.inner().clone();
    blocking(move || {
        let rules = st.db.list_rules(&repo_id)?;
        let rule = sync_engine::matching_rules(&rules, &branch_name)
            .first()
            .map(|r| (*r).clone())
            .ok_or_else(|| AppError::new("sync.noRule").param("branch", &branch_name))?;
        match prefer {
            UpstreamResolution::Rule => {
                let p = rule.primary().ok_or_else(|| AppError::new("sync.noPrimary"))?;
                let remote = p.remote.clone().ok_or_else(|| AppError::new("sync.primaryIsUrl"))?;
                let rb = sync_engine::expand_branch(&p.remote_branch, &branch_name);
                st.write(&repo_id, |r| branch::set_upstream_config(r, &branch_name, &remote, &rb))
            }
            UpstreamResolution::Git => {
                let b = st
                    .read(&repo_id, branch::local_branches)?
                    .into_iter()
                    .find(|b| b.name == branch_name)
                    .ok_or_else(|| AppError::new("arg.invalid").param("kind", "branch").param("value", &branch_name))?;
                let (Some(ur), Some(ub)) = (b.upstream_remote.clone(), b.upstream_branch.clone()) else {
                    // 命令行解除了 upstream：清除规则的 primary
                    let mut r2 = rule.clone();
                    r2.primary_target_id = None;
                    st.db.upsert_rule(&r2)?;
                    return Ok(());
                };
                let mut r2 = rule.clone();
                // 通配规则中，若 upstream 与分支同名，用 ${branch} 模板
                let template = if r2.is_wildcard() && ub == branch_name { "${branch}".to_string() } else { ub.clone() };
                let existing = r2
                    .targets
                    .iter()
                    .find(|t| t.remote.as_deref() == Some(ur.as_str()) && sync_engine::expand_branch(&t.remote_branch, &branch_name) == ub)
                    .map(|t| t.id.clone());
                let id = match existing {
                    Some(id) => id,
                    None => {
                        let id = uuid::Uuid::new_v4().to_string();
                        r2.targets.push(SyncTarget {
                            id: id.clone(),
                            remote: Some(ur),
                            url: None,
                            remote_branch: template,
                            direction: sync_engine::SyncDirection::Both,
                            force: false,
                            enabled: true,
                        });
                        id
                    }
                };
                r2.primary_target_id = Some(id);
                st.db.upsert_rule(&r2)?;
                Ok(())
            }
        }
    })
    .await
}

/// 按规则同步（M-05）：后台任务，结果在 task.output 中以 JSON（SyncReport）返回
#[tauri::command]
pub fn task_sync(app: AppHandle, state: State<'_, AppState>, repo_id: String, req: SyncRunReq) -> AppResult<String> {
    let rules = state.db.list_rules(&repo_id)?;
    let label = req.branches.as_ref().map(|b| b.join(", ")).unwrap_or_default();
    repo_task(&app, state.inner(), &repo_id, "sync", &[("branches", label.as_str())], move |r, c, p| {
        let branches = branch::list(r)?;
        let report = sync_engine::run(r, &branches, &rules, &req, c, &p)?;
        let failed = report
            .results
            .iter()
            .filter(|x| !matches!(x.outcome, TargetOutcome::Success | TargetOutcome::UpToDate))
            .count();
        let json = serde_json::to_string(&report)?;
        if failed > 0 || report.conflict {
            // 部分失败：任务标记为失败，但仍把完整报告放在 detail 中供前端展示
            return Err(AppError::new("sync.partial").param("failed", failed).param("total", report.results.len()).detail(json));
        }
        Ok(json)
    })
}

// ======================= M2：冲突（X-01 ~ X-05） =======================

#[tauri::command]
pub async fn conflict_context(state: State<'_, AppState>, repo_id: String) -> AppResult<ConflictContext> {
    let st = state.inner().clone();
    blocking(move || st.read(&repo_id, conflict::context)).await
}

#[tauri::command]
pub async fn conflict_load(state: State<'_, AppState>, repo_id: String, path: String) -> AppResult<MergeData> {
    let st = state.inner().clone();
    blocking(move || st.read(&repo_id, |r| conflict::load(r, &path))).await
}

#[tauri::command]
pub async fn conflict_accept(state: State<'_, AppState>, repo_id: String, paths: Vec<String>, side: Side) -> AppResult<()> {
    let st = state.inner().clone();
    blocking(move || st.write(&repo_id, |r| conflict::accept(r, &paths, side))).await
}

/// content 为 None 表示解决为删除文件
#[tauri::command]
pub async fn conflict_resolve(state: State<'_, AppState>, repo_id: String, path: String, content: Option<String>) -> AppResult<()> {
    let st = state.inner().clone();
    blocking(move || st.write(&repo_id, |r| conflict::resolve(r, &path, content.as_deref()))).await
}

// ======================= M2：日志（L-01、L-03、L-04） =======================

#[tauri::command]
pub async fn log_page(state: State<'_, AppState>, repo_id: String, query: LogQuery) -> AppResult<LogPage> {
    let st = state.inner().clone();
    blocking(move || st.read(&repo_id, |r| log::log(r, &query))).await
}

#[tauri::command]
pub async fn log_detail(state: State<'_, AppState>, repo_id: String, hash: String) -> AppResult<CommitDetail> {
    let st = state.inner().clone();
    blocking(move || st.read(&repo_id, |r| log::detail(r, &hash))).await
}

#[tauri::command]
pub async fn log_reset(state: State<'_, AppState>, repo_id: String, hash: String, mode: ResetMode) -> AppResult<()> {
    let st = state.inner().clone();
    blocking(move || st.write(&repo_id, |r| log::reset(r, &hash, mode))).await
}

#[tauri::command]
pub async fn log_revert(state: State<'_, AppState>, repo_id: String, hash: String) -> AppResult<IntegrateResult> {
    let st = state.inner().clone();
    blocking(move || st.write(&repo_id, |r| log::revert(r, &hash))).await
}

#[tauri::command]
pub async fn log_cherry_pick(state: State<'_, AppState>, repo_id: String, hash: String) -> AppResult<IntegrateResult> {
    let st = state.inner().clone();
    blocking(move || st.write(&repo_id, |r| log::cherry_pick(r, &hash))).await
}

#[tauri::command]
pub async fn log_create_tag(state: State<'_, AppState>, repo_id: String, name: String, hash: String, message: Option<String>) -> AppResult<()> {
    let st = state.inner().clone();
    blocking(move || st.write(&repo_id, |r| log::create_tag(r, &name, &hash, message.as_deref()))).await
}

#[tauri::command]
pub fn task_push(app: AppHandle, state: State<'_, AppState>, repo_id: String, req: PushReq) -> AppResult<String> {
    let target = format!("{}/{}", req.remote, req.remote_branch);
    let branch = req.branch.clone();
    repo_task(&app, state.inner(), &repo_id, "push", &[("branch", branch.as_str()), ("target", target.as_str())], move |r, c, p| {
        sync::push(r, &req, c, Some(p))
    })
}

// ======================= M3：Stash（C-10） =======================

#[tauri::command]
pub async fn stash_list(state: State<'_, AppState>, repo_id: String) -> AppResult<Vec<StashEntry>> {
    let st = state.inner().clone();
    blocking(move || st.read(&repo_id, stash::list)).await
}

#[tauri::command]
pub async fn stash_files(state: State<'_, AppState>, repo_id: String, hash: String) -> AppResult<Vec<StashFile>> {
    let st = state.inner().clone();
    blocking(move || st.read(&repo_id, |r| stash::files(r, &hash))).await
}

#[tauri::command]
pub async fn stash_create(state: State<'_, AppState>, repo_id: String, req: StashCreateReq) -> AppResult<()> {
    let st = state.inner().clone();
    blocking(move || st.write(&repo_id, |r| stash::create(r, &req))).await
}

#[tauri::command]
pub async fn stash_apply(state: State<'_, AppState>, repo_id: String, hash: String, pop: bool, restore_index: bool) -> AppResult<IntegrateResult> {
    let st = state.inner().clone();
    blocking(move || st.write(&repo_id, |r| stash::apply(r, &hash, pop, restore_index))).await
}

#[tauri::command]
pub async fn stash_drop(state: State<'_, AppState>, repo_id: String, hash: String) -> AppResult<()> {
    let st = state.inner().clone();
    blocking(move || st.write(&repo_id, |r| stash::drop(r, &hash))).await
}

#[tauri::command]
pub async fn stash_branch(state: State<'_, AppState>, repo_id: String, hash: String, name: String) -> AppResult<()> {
    let st = state.inner().clone();
    blocking(move || st.write(&repo_id, |r| stash::branch(r, &hash, &name))).await
}

// ======================= M3：变更列表（C-09） =======================

fn clean_name(name: &str) -> AppResult<String> {
    let n = name.trim();
    if n.is_empty() || n.chars().count() > 100 {
        return Err(AppError::new("arg.invalid").param("kind", "name").param("value", n));
    }
    Ok(n.to_string())
}

#[tauri::command]
pub async fn changelist_list(state: State<'_, AppState>, repo_id: String) -> AppResult<Vec<Changelist>> {
    let st = state.inner().clone();
    blocking(move || st.db.list_changelists(&repo_id)).await
}

#[tauri::command]
pub async fn changelist_create(state: State<'_, AppState>, repo_id: String, name: String) -> AppResult<Changelist> {
    let st = state.inner().clone();
    blocking(move || st.db.create_changelist(&repo_id, &clean_name(&name)?)).await
}

#[tauri::command]
pub async fn changelist_rename(state: State<'_, AppState>, id: String, name: String) -> AppResult<()> {
    let st = state.inner().clone();
    blocking(move || st.db.rename_changelist(&id, &clean_name(&name)?)).await
}

#[tauri::command]
pub async fn changelist_delete(state: State<'_, AppState>, repo_id: String, id: String) -> AppResult<()> {
    let st = state.inner().clone();
    blocking(move || st.db.delete_changelist(&repo_id, &id)).await
}

#[tauri::command]
pub async fn changelist_set_active(state: State<'_, AppState>, repo_id: String, id: String) -> AppResult<()> {
    let st = state.inner().clone();
    blocking(move || st.db.set_active_changelist(&repo_id, &id)).await
}

#[tauri::command]
pub async fn changelist_move(state: State<'_, AppState>, repo_id: String, id: String, paths: Vec<String>) -> AppResult<()> {
    let st = state.inner().clone();
    blocking(move || st.db.move_to_changelist(&repo_id, &id, &paths)).await
}

// ======================= M3：分组（R-04） =======================

#[tauri::command]
pub async fn group_list(state: State<'_, AppState>) -> AppResult<Vec<RepoGroup>> {
    let st = state.inner().clone();
    blocking(move || st.db.list_groups()).await
}

#[tauri::command]
pub async fn group_create(state: State<'_, AppState>, name: String) -> AppResult<RepoGroup> {
    let st = state.inner().clone();
    blocking(move || st.db.create_group(&clean_name(&name)?)).await
}

#[tauri::command]
pub async fn group_rename(state: State<'_, AppState>, id: String, name: String) -> AppResult<()> {
    let st = state.inner().clone();
    blocking(move || st.db.rename_group(&id, &clean_name(&name)?)).await
}

#[tauri::command]
pub async fn group_delete(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let st = state.inner().clone();
    blocking(move || st.db.delete_group(&id)).await
}

#[tauri::command]
pub async fn group_reorder(state: State<'_, AppState>, ids: Vec<String>) -> AppResult<()> {
    let st = state.inner().clone();
    blocking(move || st.db.reorder_groups(&ids)).await
}

#[tauri::command]
pub async fn group_set_collapsed(state: State<'_, AppState>, id: String, collapsed: bool) -> AppResult<()> {
    let st = state.inner().clone();
    blocking(move || st.db.set_group_collapsed(&id, collapsed)).await
}

/// 拖拽排序：把 orderedIds 中的仓库放进 groupId（null = 未分组），并按顺序写入 sort
#[tauri::command]
pub async fn repo_move(state: State<'_, AppState>, group_id: Option<String>, ordered_ids: Vec<String>) -> AppResult<()> {
    let st = state.inner().clone();
    blocking(move || st.db.move_repos(group_id.as_deref(), &ordered_ids)).await
}

#[tauri::command]
pub async fn repo_set_group(state: State<'_, AppState>, repo_id: String, group_id: Option<String>) -> AppResult<()> {
    let st = state.inner().clone();
    blocking(move || st.db.set_repo_group(&repo_id, group_id.as_deref())).await
}

// ======================= M3：扫描导入（R-03）、外部打开（R-08） =======================

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub repos: Vec<ScanItem>,
    pub truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanItem {
    #[serde(flatten)]
    pub found: FoundRepo,
    pub registered: bool,
}

#[tauri::command]
pub async fn repo_scan(state: State<'_, AppState>, path: String, depth: u32) -> AppResult<ScanResult> {
    let st = state.inner().clone();
    blocking(move || {
        let (found, truncated) = system::scan_repos(Path::new(&path), depth)?;
        let repos = found
            .into_iter()
            .map(|f| {
                let p = normalize_root(&f.path);
                let registered = st.db.find_repo_by_path(&p).ok().flatten().is_some();
                ScanItem { found: FoundRepo { path: p, ..f }, registered }
            })
            .collect();
        Ok(ScanResult { repos, truncated })
    })
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub added: Vec<RepoRecord>,
    pub failed: Vec<(String, AppError)>,
}

/// 批量导入扫描结果，可选同时放入某个分组
#[tauri::command]
pub async fn repo_add_many(app: AppHandle, state: State<'_, AppState>, paths: Vec<String>, group_id: Option<String>) -> AppResult<ImportResult> {
    let st = state.inner().clone();
    blocking(move || {
        let mut res = ImportResult { added: Vec::new(), failed: Vec::new() };
        for p in paths {
            let r = (|| {
                let out = st.git.run(Path::new(&p), &["rev-parse", "--show-toplevel"], &RunOpts::read())?;
                let rec = register(&st, &app, &normalize_root(&out.text()))?;
                if let Some(g) = &group_id {
                    st.db.set_repo_group(&rec.id, Some(g))?;
                }
                Ok::<_, AppError>(rec)
            })();
            match r {
                Ok(rec) => res.added.push(rec),
                Err(e) => res.failed.push((p, e)),
            }
        }
        Ok(res)
    })
    .await
}

/// 在外部打开（R-08）。rel 为仓库内相对路径（在文件管理器中显示某个文件时使用）
#[tauri::command]
pub async fn open_external(state: State<'_, AppState>, repo_id: String, rel: Option<String>, target: OpenTarget) -> AppResult<()> {
    let st = state.inner().clone();
    blocking(move || {
        let root = st.repo_path(&repo_id)?;
        let path = match rel.as_deref().filter(|s| !s.is_empty()) {
            Some(r) => crate::git::safe_join(&root, r)?,
            None => root,
        };
        let app = match target {
            OpenTarget::Terminal => st.db.get_setting("terminalApp")?,
            OpenTarget::Editor => st.db.get_setting("editorApp")?,
            _ => None,
        };
        system::open_external(&path, target, app.as_deref())
    })
    .await
}

// ======================= M3：日志过滤、文件历史、Blame、比较（L-02、L-05、B-06、D-06） =======================

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileHistoryPage {
    pub entries: Vec<FileHistoryEntry>,
    pub has_more: bool,
}

#[tauri::command]
pub async fn log_file_history(state: State<'_, AppState>, repo_id: String, path: String, skip: u32) -> AppResult<FileHistoryPage> {
    let st = state.inner().clone();
    blocking(move || {
        st.read(&repo_id, |r| {
            let (entries, has_more) = log::file_history(r, &path, skip, None)?;
            Ok(FileHistoryPage { entries, has_more })
        })
    })
    .await
}

#[tauri::command]
pub async fn log_blame(state: State<'_, AppState>, repo_id: String, path: String, rev: Option<String>) -> AppResult<BlameResult> {
    let st = state.inner().clone();
    blocking(move || st.read(&repo_id, |r| log::blame(r, &path, rev.as_deref()))).await
}

#[tauri::command]
pub async fn compare_refs(state: State<'_, AppState>, repo_id: String, left: String, right: String) -> AppResult<RefCompare> {
    let st = state.inner().clone();
    blocking(move || st.read(&repo_id, |r| log::compare_refs(r, &left, &right))).await
}

/// right 为 None 表示工作区
#[tauri::command]
pub async fn compare_files(state: State<'_, AppState>, repo_id: String, left: String, right: Option<String>) -> AppResult<Vec<CommitFile>> {
    let st = state.inner().clone();
    blocking(move || st.read(&repo_id, |r| log::compare_files(r, &left, right.as_deref()))).await
}

/// 二进制 / 图片内容（D-05）。rev：None = 工作区，"" = 暂存区，其他为提交/分支
#[tauri::command]
pub async fn blob_data(state: State<'_, AppState>, repo_id: String, rev: Option<String>, path: String) -> AppResult<BlobData> {
    let st = state.inner().clone();
    blocking(move || st.read(&repo_id, |r| log::blob_data(r, rev.as_deref(), &path))).await
}

// ======================= M3：标签（B-08） =======================

#[tauri::command]
pub async fn tag_list(state: State<'_, AppState>, repo_id: String) -> AppResult<Vec<TagInfo>> {
    let st = state.inner().clone();
    blocking(move || st.read(&repo_id, log::list_tags)).await
}

#[tauri::command]
pub async fn tag_delete(state: State<'_, AppState>, repo_id: String, name: String) -> AppResult<()> {
    let st = state.inner().clone();
    blocking(move || st.write(&repo_id, |r| log::delete_tag(r, &name))).await
}

/// 推送标签；name 为空推送全部
#[tauri::command]
pub fn task_tag_push(app: AppHandle, state: State<'_, AppState>, repo_id: String, remote: String, name: Option<String>) -> AppResult<String> {
    let label = name.clone().unwrap_or_else(|| "*".into());
    let rlabel = remote.clone();
    repo_task(&app, state.inner(), &repo_id, "tagPush", &[("tag", label.as_str()), ("remote", rlabel.as_str())], move |r, c, _| {
        log::push_tag(r, &remote, name.as_deref(), c)
    })
}

#[tauri::command]
pub fn task_tag_delete_remote(app: AppHandle, state: State<'_, AppState>, repo_id: String, remote: String, name: String) -> AppResult<String> {
    let (tl, rl) = (name.clone(), remote.clone());
    repo_task(&app, state.inner(), &repo_id, "tagDeleteRemote", &[("tag", tl.as_str()), ("remote", rl.as_str())], move |r, c, _| {
        log::delete_remote_tag(r, &remote, &name, c)?;
        Ok(String::new())
    })
}

// ======================= M3：提交前检查、偏差检测（specs/04 2.3、M-07） =======================

#[tauri::command]
pub async fn commit_precheck(state: State<'_, AppState>, repo_id: String, paths: Vec<String>) -> AppResult<Vec<PrecheckIssue>> {
    let st = state.inner().clone();
    blocking(move || {
        let get = |k: &str| st.db.get_setting(k).ok().flatten();
        let d = PrecheckOpts::default();
        let opts = PrecheckOpts {
            large_file_mb: get("precheck.largeFileMb").and_then(|v| v.parse().ok()).unwrap_or(d.large_file_mb),
            secrets: get("precheck.secrets").map(|v| v != "false").unwrap_or(d.secrets),
            todo: get("precheck.todo").map(|v| v == "true").unwrap_or(d.todo),
        };
        if get("precheck.enabled").map(|v| v == "false").unwrap_or(false) {
            return Ok(Vec::new());
        }
        st.read(&repo_id, |r| precheck::run(r, &paths, &opts))
    })
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteHealth {
    pub name: String,
    pub result: RemoteTestResult,
}

/// 检测仓库所有 remote 的连通性（M-07：远端 URL 失效）。可能较慢，前端按需调用并缓存
#[tauri::command]
pub async fn remote_check_all(state: State<'_, AppState>, repo_id: String) -> AppResult<Vec<RemoteHealth>> {
    let st = state.inner().clone();
    blocking(move || {
        st.read(&repo_id, |r| {
            let token = crate::git::runner::CancelToken::new();
            let names = r.remotes()?;
            // 并行检测，每个 remote 一个线程
            let handles: Vec<_> = names
                .into_iter()
                .map(|n| {
                    let git = st.git.clone();
                    let path = r.path.clone();
                    let t = token.clone();
                    std::thread::spawn(move || {
                        let repo = Repo::new(&git, path);
                        let result = remote::test(&repo, &n, &t)
                            .unwrap_or_else(|e| RemoteTestResult { ok: false, heads: 0, error: Some(e) });
                        RemoteHealth { name: n, result }
                    })
                })
                .collect();
            Ok(handles.into_iter().filter_map(|h| h.join().ok()).collect())
        })
    })
    .await
}
