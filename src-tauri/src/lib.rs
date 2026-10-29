pub mod askpass;
pub mod commands;
pub mod diff3;
pub mod error;
pub mod git;
pub mod security;
pub mod storage;
pub mod sync_engine;
pub mod system;
pub mod tasks;
pub mod watcher;

use commands::AppState;
use git::runner::{detect_git, GitRunner};
use std::path::Path;
use std::sync::Arc;
use tauri::{Emitter, Manager};

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let db = Arc::new(storage::Db::open(&data_dir.join("gitmanagement.db")).map_err(|e| e.to_string())?);

            let configured = db.get_setting("gitPath").ok().flatten();
            let git = Arc::new(GitRunner::new(detect_git(configured.as_deref())));
            // 命令日志（T-06）实时推送到前端底部面板
            let handle = app.handle().clone();
            git.set_sink(Arc::new(move |entry: &git::runner::CommandLogEntry| {
                let _ = handle.emit("command-log", entry);
            }));

            let parallel = db
                .get_setting("maxParallel")
                .ok()
                .flatten()
                .and_then(|v| v.parse().ok())
                .unwrap_or(4);
            let state = AppState {
                db: db.clone(),
                git,
                tasks: Arc::new(tasks::TaskManager::new(parallel)),
                watcher: Arc::new(watcher::WatchManager::new()),
            };

            // 启动时为已登记且开启自动刷新的仓库建立文件监听（R-09）
            if let Ok(repos) = db.list_repos() {
                for r in repos {
                    if Path::new(&r.path).is_dir() && state.auto_refresh_enabled(&r.id) {
                        state.watcher.watch(app.handle(), &r.id, Path::new(&r.path));
                    }
                }
            }
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::git_set_path,
            commands::settings_get_all,
            commands::settings_set,
            commands::command_log_list,
            commands::command_log_clear,
            commands::repo_list,
            commands::repo_summary,
            commands::repo_check_path,
            commands::repo_add,
            commands::repo_remove,
            commands::repo_rename,
            commands::repo_set_favorite,
            commands::repo_set_watch,
            commands::status_get,
            commands::checked_get,
            commands::checked_set,
            commands::diff_file,
            commands::worktree_write,
            commands::commit_create,
            commands::commit_messages,
            commands::commit_head_message,
            commands::commit_merge_message,
            commands::changes_rollback,
            commands::changes_add,
            commands::changes_ignore,
            commands::branch_list,
            commands::branch_create,
            commands::branch_checkout,
            commands::branch_checkout_remote,
            commands::branch_rename,
            commands::branch_delete,
            commands::branch_delete_remote,
            commands::branch_integrate,
            commands::branch_set_upstream,
            commands::operation_action,
            commands::remote_list,
            commands::push_preview,
            commands::identity_get,
            commands::identity_set,
            commands::credential_save,
            commands::credential_delete,
            commands::credential_get_user,
            commands::task_list,
            commands::task_cancel,
            commands::task_clear,
            commands::task_clone,
            commands::task_fetch,
            commands::task_fetch_all,
            commands::task_pull,
            commands::task_push,
            commands::remote_add,
            commands::remote_update,
            commands::remote_remove,
            commands::remote_test,
            commands::sync_rules,
            commands::sync_rule_upsert,
            commands::sync_rule_delete,
            commands::sync_mapping,
            commands::sync_resolve_upstream,
            commands::task_sync,
            commands::conflict_context,
            commands::conflict_load,
            commands::conflict_accept,
            commands::conflict_resolve,
            commands::log_page,
            commands::log_detail,
            commands::log_reset,
            commands::log_revert,
            commands::log_cherry_pick,
            commands::log_create_tag,
            commands::stash_list,
            commands::stash_files,
            commands::stash_create,
            commands::stash_apply,
            commands::stash_drop,
            commands::stash_branch,
            commands::changelist_list,
            commands::changelist_create,
            commands::changelist_rename,
            commands::changelist_delete,
            commands::changelist_set_active,
            commands::changelist_move,
            commands::group_list,
            commands::group_create,
            commands::group_rename,
            commands::group_delete,
            commands::group_reorder,
            commands::group_set_collapsed,
            commands::repo_move,
            commands::repo_set_group,
            commands::repo_scan,
            commands::repo_add_many,
            commands::open_external,
            commands::log_file_history,
            commands::log_blame,
            commands::compare_refs,
            commands::compare_files,
            commands::blob_data,
            commands::tag_list,
            commands::tag_delete,
            commands::task_tag_push,
            commands::task_tag_delete_remote,
            commands::commit_precheck,
            commands::remote_check_all,
        ])
        .run(tauri::generate_context!())
        .expect("error while running GitManagement");
}
