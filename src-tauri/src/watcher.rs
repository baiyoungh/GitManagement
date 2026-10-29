//! 文件监听（R-09）：工作区变化 → 防抖 → 推送 `repo-changed` 事件。
//!
//! 忽略 .git/objects 等高频噪声；index、HEAD、refs 变化仍会触发（命令行 commit/checkout 后自动刷新）。

use notify_debouncer_mini::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

const DEBOUNCE: Duration = Duration::from_millis(400);

pub struct WatchManager {
    watchers: Mutex<HashMap<String, Debouncer<RecommendedWatcher>>>,
}

fn is_noise(repo_root: &Path, p: &Path) -> bool {
    let rel = match p.strip_prefix(repo_root) {
        Ok(r) => r,
        Err(_) => return false,
    };
    let parts: Vec<String> = rel
        .components()
        .filter_map(|c| match c {
            Component::Normal(s) => Some(s.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect();
    if parts.first().map(|s| s == ".git").unwrap_or(false) {
        let second = parts.get(1).map(String::as_str).unwrap_or("");
        // 关心 index / HEAD / refs / 合并状态文件，忽略对象库、日志与锁文件
        if matches!(second, "objects" | "logs" | "lfs" | "hooks" | "info") {
            return true;
        }
        if parts.last().map(|s| s.ends_with(".lock")).unwrap_or(false) {
            return true;
        }
        return false;
    }
    // 常见构建产物目录，变化频繁且通常被忽略
    parts.iter().any(|s| matches!(s.as_str(), "node_modules" | "target" | ".DS_Store"))
}

impl WatchManager {
    pub fn new() -> Self {
        Self { watchers: Mutex::new(HashMap::new()) }
    }

    pub fn watch(&self, app: &AppHandle, repo_id: &str, path: &Path) {
        let mut ws = self.watchers.lock().unwrap_or_else(|e| e.into_inner());
        if ws.contains_key(repo_id) {
            return;
        }
        let app = app.clone();
        let rid = repo_id.to_string();
        let root: PathBuf = path.to_path_buf();
        let root_cb = root.clone();
        let deb = new_debouncer(DEBOUNCE, move |res: DebounceEventResult| {
            if let Ok(events) = res {
                if events.iter().any(|e| !is_noise(&root_cb, &e.path)) {
                    let _ = app.emit("repo-changed", serde_json::json!({ "repoId": rid }));
                }
            }
        });
        if let Ok(mut d) = deb {
            if d.watcher().watch(&root, RecursiveMode::Recursive).is_ok() {
                ws.insert(repo_id.to_string(), d);
            }
        }
    }

    pub fn unwatch(&self, repo_id: &str) {
        self.watchers.lock().unwrap_or_else(|e| e.into_inner()).remove(repo_id);
    }

    pub fn is_watching(&self, repo_id: &str) -> bool {
        self.watchers.lock().unwrap_or_else(|e| e.into_inner()).contains_key(repo_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn noise_filter() {
        let root = Path::new("/r");
        assert!(is_noise(root, Path::new("/r/.git/objects/ab/cdef")));
        assert!(is_noise(root, Path::new("/r/.git/index.lock")));
        assert!(!is_noise(root, Path::new("/r/.git/index")));
        assert!(!is_noise(root, Path::new("/r/.git/HEAD")));
        assert!(!is_noise(root, Path::new("/r/src/a.ts")));
        assert!(is_noise(root, Path::new("/r/web/node_modules/x/index.js")));
    }
}
