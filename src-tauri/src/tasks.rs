//! 后台任务队列（S-04；specs/07 第 2.1 节）。
//!
//! - 同一仓库的写操作串行：每个仓库一把锁，同步写命令与后台任务共用。
//! - 不同仓库之间并行，全局并发上限默认 4。
//! - 长任务可取消（终止 git 子进程），进度与结果通过事件推送给前端。

use crate::error::{AppError, AppResult};
use crate::git::runner::{CancelToken, ProgressFn};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskInfo {
    pub id: String,
    pub repo_id: Option<String>,
    /// 任务种类：clone / fetch / pull / push / fetchAll …，前端据此翻译标题
    pub kind: String,
    /// 标题参数（仓库名、远端、分支等）
    pub params: HashMap<String, String>,
    pub state: TaskState,
    pub percent: Option<u8>,
    pub message: String,
    pub started_at: u64,
    pub error: Option<AppError>,
    pub output: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TaskState {
    Queued,
    Running,
    Succeeded,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgressEvent {
    task_id: String,
    percent: Option<u8>,
    message: String,
}

/// 计数信号量，限制跨仓库并发
struct Semaphore {
    count: Mutex<usize>,
    cv: Condvar,
}

impl Semaphore {
    fn new(n: usize) -> Self {
        Self { count: Mutex::new(n), cv: Condvar::new() }
    }
    fn acquire(&self) {
        let mut c = self.count.lock().unwrap_or_else(|e| e.into_inner());
        while *c == 0 {
            c = self.cv.wait(c).unwrap_or_else(|e| e.into_inner());
        }
        *c -= 1;
    }
    fn release(&self) {
        *self.count.lock().unwrap_or_else(|e| e.into_inner()) += 1;
        self.cv.notify_one();
    }
}

pub struct TaskManager {
    tasks: Mutex<HashMap<String, (TaskInfo, CancelToken)>>,
    repo_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    slots: Arc<Semaphore>,
}

const MAX_FINISHED: usize = 200;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

impl TaskManager {
    pub fn new(max_parallel: usize) -> Self {
        Self {
            tasks: Mutex::new(HashMap::new()),
            repo_locks: Mutex::new(HashMap::new()),
            slots: Arc::new(Semaphore::new(max_parallel.max(1))),
        }
    }

    /// 仓库写锁：同步写命令也通过它与后台任务串行
    pub fn repo_lock(&self, repo_id: &str) -> Arc<Mutex<()>> {
        self.repo_locks
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entry(repo_id.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    pub fn list(&self) -> Vec<TaskInfo> {
        let mut v: Vec<TaskInfo> = self
            .tasks
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .map(|(t, _)| t.clone())
            .collect();
        v.sort_by(|a, b| b.started_at.cmp(&a.started_at));
        v
    }

    pub fn cancel(&self, id: &str) -> bool {
        match self.tasks.lock().unwrap_or_else(|e| e.into_inner()).get(id) {
            Some((_, token)) => {
                token.cancel();
                true
            }
            None => false,
        }
    }

    pub fn clear_finished(&self) {
        self.tasks
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|_, (t, _)| matches!(t.state, TaskState::Queued | TaskState::Running));
    }

    fn update(&self, app: &AppHandle, id: &str, f: impl FnOnce(&mut TaskInfo)) {
        let snapshot = {
            let mut tasks = self.tasks.lock().unwrap_or_else(|e| e.into_inner());
            match tasks.get_mut(id) {
                Some((t, _)) => {
                    f(t);
                    t.clone()
                }
                None => return,
            }
        };
        let _ = app.emit("task-updated", &snapshot);
    }

    fn trim(&self) {
        let mut tasks = self.tasks.lock().unwrap_or_else(|e| e.into_inner());
        let mut finished: Vec<(String, u64)> = tasks
            .iter()
            .filter(|(_, (t, _))| !matches!(t.state, TaskState::Queued | TaskState::Running))
            .map(|(k, (t, _))| (k.clone(), t.started_at))
            .collect();
        if finished.len() > MAX_FINISHED {
            finished.sort_by_key(|(_, ts)| *ts);
            for (k, _) in finished.iter().take(finished.len() - MAX_FINISHED) {
                tasks.remove(k);
            }
        }
    }

    /// 提交后台任务；`job` 在工作线程中执行，返回值作为任务输出。
    pub fn spawn<F>(
        self: &Arc<Self>,
        app: &AppHandle,
        repo_id: Option<String>,
        kind: &str,
        params: HashMap<String, String>,
        job: F,
    ) -> String
    where
        F: FnOnce(&CancelToken, ProgressFn) -> AppResult<String> + Send + 'static,
    {
        let id = uuid::Uuid::new_v4().to_string();
        let token = CancelToken::new();
        let info = TaskInfo {
            id: id.clone(),
            repo_id: repo_id.clone(),
            kind: kind.to_string(),
            params,
            state: TaskState::Queued,
            percent: None,
            message: String::new(),
            started_at: now_ms(),
            error: None,
            output: None,
        };
        self.tasks
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id.clone(), (info.clone(), token.clone()));
        let _ = app.emit("task-updated", &info);
        self.trim();

        let mgr = Arc::clone(self);
        let app = app.clone();
        let task_id = id.clone();
        std::thread::spawn(move || {
            mgr.slots.acquire();
            let lock = repo_id.as_deref().map(|r| mgr.repo_lock(r));
            let _guard = lock.as_ref().map(|l| l.lock().unwrap_or_else(|e| e.into_inner()));

            let result = if token.is_cancelled() {
                Err(AppError::new("task.cancelled"))
            } else {
                mgr.update(&app, &task_id, |t| t.state = TaskState::Running);
                let app_p = app.clone();
                let tid = task_id.clone();
                let progress: ProgressFn = Arc::new(move |percent: Option<u8>, line: &str| {
                    let _ = app_p.emit(
                        "task-progress",
                        ProgressEvent { task_id: tid.clone(), percent, message: line.to_string() },
                    );
                });
                job(&token, progress)
            };
            drop(_guard);
            mgr.slots.release();

            mgr.update(&app, &task_id, |t| match result {
                Ok(out) => {
                    t.state = TaskState::Succeeded;
                    t.percent = Some(100);
                    t.output = Some(out);
                }
                Err(e) if e.code == "task.cancelled" => t.state = TaskState::Cancelled,
                Err(e) => {
                    t.state = TaskState::Failed;
                    t.error = Some(e);
                }
            });
            if let Some(r) = &repo_id {
                let _ = app.emit("repo-changed", serde_json::json!({ "repoId": r }));
            }
        });
        id
    }
}
