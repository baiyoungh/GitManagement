//! git 子进程调用（specs/07 第 2.2 节）。
//!
//! - 参数始终以数组传递，不经过 shell。
//! - 固定环境变量：GIT_TERMINAL_PROMPT=0、LC_ALL=C、只读查询 GIT_OPTIONAL_LOCKS=0。
//! - 支持取消（终止子进程）与 `--progress` 进度解析。
//! - 每条命令写入命令日志（T-06），日志与错误输出统一脱敏。

use crate::askpass;
use crate::error::{AppError, AppResult};
use crate::security::redact;
use serde::Serialize;
use std::collections::VecDeque;
use std::ffi::OsStr;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const MIN_GIT_VERSION: (u32, u32, u32) = (2, 30, 0);
const LOG_CAPACITY: usize = 1000;
const LOG_OUTPUT_LIMIT: usize = 4000;

#[derive(Clone, Default)]
pub struct CancelToken(Arc<AtomicBool>);

impl CancelToken {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

/// 进度回调：(百分比, 原始进度行)
pub type ProgressFn = Arc<dyn Fn(Option<u8>, &str) + Send + Sync>;

#[derive(Clone, Default)]
pub struct RunOpts {
    pub stdin: Option<Vec<u8>>,
    pub cancel: Option<CancelToken>,
    pub progress: Option<ProgressFn>,
    /// 只读查询：设置 GIT_OPTIONAL_LOCKS=0，避免与写操作抢 index.lock
    pub read_only: bool,
    /// 路径参数按字面量处理（GIT_LITERAL_PATHSPECS=1），文件名中的 `*?[` 不会被当作通配符
    pub literal_pathspecs: bool,
    /// 视为成功的非 0 退出码（例如 `diff --no-index` 有差异时返回 1）
    pub ok_codes: Vec<i32>,
}

impl RunOpts {
    pub fn read() -> Self {
        Self {
            read_only: true,
            ..Default::default()
        }
    }
    pub fn literal() -> Self {
        Self {
            literal_pathspecs: true,
            ..Default::default()
        }
    }
}

#[derive(Debug, Clone)]
pub struct GitOutput {
    pub code: i32,
    pub stdout: Vec<u8>,
    pub stderr: String,
}

impl GitOutput {
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.stdout).into_owned()
    }
    pub fn trimmed(&self) -> String {
        self.text().trim().to_string()
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandLogEntry {
    pub id: u64,
    pub cwd: String,
    pub command: String,
    pub started_at: u64,
    pub duration_ms: u64,
    pub exit_code: Option<i32>,
    pub output: String,
}

pub type LogSink = Arc<dyn Fn(&CommandLogEntry) + Send + Sync>;

pub struct GitRunner {
    git: RwLock<PathBuf>,
    askpass: Option<PathBuf>,
    log: Mutex<VecDeque<CommandLogEntry>>,
    next_id: AtomicU64,
    sink: RwLock<Option<LogSink>>,
}

impl GitRunner {
    pub fn new(git: PathBuf) -> Self {
        Self {
            git: RwLock::new(git),
            askpass: std::env::current_exe().ok(),
            log: Mutex::new(VecDeque::with_capacity(LOG_CAPACITY)),
            next_id: AtomicU64::new(1),
            sink: RwLock::new(None),
        }
    }

    pub fn git_path(&self) -> PathBuf {
        self.git.read().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub fn set_git_path(&self, path: PathBuf) {
        *self.git.write().unwrap_or_else(|e| e.into_inner()) = path;
    }

    pub fn set_sink(&self, sink: LogSink) {
        *self.sink.write().unwrap_or_else(|e| e.into_inner()) = Some(sink);
    }

    pub fn log_entries(&self) -> Vec<CommandLogEntry> {
        self.log.lock().unwrap_or_else(|e| e.into_inner()).iter().cloned().collect()
    }

    pub fn clear_log(&self) {
        self.log.lock().unwrap_or_else(|e| e.into_inner()).clear();
    }

    /// 执行 git 命令；非 0 退出码（不在 ok_codes 中）转换为分类后的 AppError。
    pub fn run<S: AsRef<OsStr>>(&self, cwd: &Path, args: &[S], opts: &RunOpts) -> AppResult<GitOutput> {
        let out = self.exec(cwd, args, opts)?;
        if out.code == 0 || opts.ok_codes.contains(&out.code) {
            Ok(out)
        } else {
            Err(classify(&out.stderr, &out.text()))
        }
    }

    /// 执行 git 命令，不论退出码都返回输出（仅在无法启动或被取消时返回错误）。
    pub fn exec<S: AsRef<OsStr>>(&self, cwd: &Path, args: &[S], opts: &RunOpts) -> AppResult<GitOutput> {
        let git = self.git_path();
        let mut cmd = Command::new(&git);
        cmd.arg("-c").arg("core.quotepath=false").arg("-c").arg("color.ui=false");
        cmd.args(args);
        cmd.current_dir(cwd);
        cmd.env("GIT_TERMINAL_PROMPT", "0")
            .env("LC_ALL", "C")
            .env("LANGUAGE", "C")
            .env("GIT_PAGER", "cat")
            .env("GIT_EDITOR", ":")
            .env("GIT_SEQUENCE_EDITOR", ":")
            .env("GIT_MERGE_AUTOEDIT", "no");
        if opts.read_only {
            cmd.env("GIT_OPTIONAL_LOCKS", "0");
        }
        if opts.literal_pathspecs {
            cmd.env("GIT_LITERAL_PATHSPECS", "1");
        }
        if let Some(a) = &self.askpass {
            cmd.env("GIT_ASKPASS", a).env(askpass::ENV_FLAG, "1");
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        cmd.stdin(if opts.stdin.is_some() { Stdio::piped() } else { Stdio::null() })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let command_text = redact(&format!(
            "git {}",
            args.iter()
                .map(|a| quote_for_log(&a.as_ref().to_string_lossy()))
                .collect::<Vec<_>>()
                .join(" ")
        ));
        let started_at = now_ms();
        let started = Instant::now();

        let mut child = cmd.spawn().map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                AppError::new("git.notFound").param("path", git.display())
            } else {
                AppError::from(e)
            }
        })?;

        // stdin / stdout / stderr 各自独立线程处理，避免管道写满导致死锁
        let stdin_handle = match (child.stdin.take(), opts.stdin.clone()) {
            (Some(mut pipe), Some(data)) => Some(std::thread::spawn(move || {
                let _ = pipe.write_all(&data);
            })),
            _ => None,
        };
        let mut stdout_pipe = child.stdout.take();
        let stdout_handle = std::thread::spawn(move || {
            let mut buf = Vec::new();
            if let Some(p) = stdout_pipe.as_mut() {
                let _ = p.read_to_end(&mut buf);
            }
            buf
        });
        let mut stderr_pipe = child.stderr.take();
        let progress = opts.progress.clone();
        let stderr_handle = std::thread::spawn(move || read_stderr(stderr_pipe.as_mut(), progress));

        let mut cancelled = false;
        let status = match &opts.cancel {
            None => child.wait()?,
            Some(token) => loop {
                if let Some(st) = child.try_wait()? {
                    break st;
                }
                if token.is_cancelled() {
                    let _ = child.kill();
                    cancelled = true;
                    break child.wait()?;
                }
                std::thread::sleep(Duration::from_millis(30));
            },
        };
        if let Some(h) = stdin_handle {
            let _ = h.join();
        }
        let stdout = stdout_handle.join().unwrap_or_default();
        let stderr = redact(&stderr_handle.join().unwrap_or_default());
        let code = status.code().unwrap_or(-1);

        self.push_log(CommandLogEntry {
            id: self.next_id.fetch_add(1, Ordering::SeqCst),
            cwd: cwd.display().to_string(),
            command: command_text,
            started_at,
            duration_ms: started.elapsed().as_millis() as u64,
            exit_code: if cancelled { None } else { Some(code) },
            output: truncate(&stderr, LOG_OUTPUT_LIMIT),
        });

        if cancelled {
            return Err(AppError::new("task.cancelled"));
        }
        Ok(GitOutput { code, stdout, stderr })
    }

    fn push_log(&self, entry: CommandLogEntry) {
        {
            let mut log = self.log.lock().unwrap_or_else(|e| e.into_inner());
            if log.len() >= LOG_CAPACITY {
                log.pop_front();
            }
            log.push_back(entry.clone());
        }
        if let Some(sink) = self.sink.read().unwrap_or_else(|e| e.into_inner()).as_ref() {
            sink(&entry);
        }
    }

    /// `git --version` → (版本号, 原始字符串)
    pub fn version(&self) -> AppResult<((u32, u32, u32), String)> {
        let out = self.run(&std::env::temp_dir(), &["--version"], &RunOpts::read())?;
        let raw = out.trimmed();
        let v = crate::git::parse::parse_version(&raw)
            .ok_or_else(|| AppError::new("git.versionUnknown").detail(raw.clone()))?;
        Ok((v, raw))
    }
}

fn read_stderr(pipe: Option<&mut std::process::ChildStderr>, progress: Option<ProgressFn>) -> String {
    let mut all = Vec::new();
    let pipe = match pipe {
        Some(p) => p,
        None => return String::new(),
    };
    let mut buf = [0u8; 4096];
    let mut line = Vec::new();
    loop {
        let n = match pipe.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        all.extend_from_slice(&buf[..n]);
        if let Some(cb) = &progress {
            for &b in &buf[..n] {
                if b == b'\r' || b == b'\n' {
                    if !line.is_empty() {
                        let text = String::from_utf8_lossy(&line).into_owned();
                        cb(parse_percent(&text), &redact(&text));
                        line.clear();
                    }
                } else {
                    line.push(b);
                }
            }
        }
    }
    String::from_utf8_lossy(&all).into_owned()
}

/// 从 "Receiving objects:  45% (450/1000)" 之类的行中取百分比
pub fn parse_percent(line: &str) -> Option<u8> {
    let idx = line.find('%')?;
    let digits: String = line[..idx]
        .chars()
        .rev()
        .take_while(|c| c.is_ascii_digit())
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    digits.parse::<u32>().ok().map(|v| v.min(100) as u8)
}

/// 识别常见 git 错误，转换为错误码；git 原文保留在 detail 中（specs/07 第 1 节）
pub fn classify(stderr: &str, stdout: &str) -> AppError {
    let combined = format!("{}\n{}", stderr, stdout);
    let s = combined.to_ascii_lowercase();
    let has = |p: &str| s.contains(p);
    let code = if has("authentication failed")
        || has("could not read username")
        || has("could not read password")
        || has("invalid username or password")
        || has("permission denied (publickey")
        || has("http basic: access denied")
        || has("terminal prompts disabled")
        || has("the requested url returned error: 401")
        || has("the requested url returned error: 403")
    {
        "git.authFailed"
    } else if has("non-fast-forward") || has("fetch first") || has("(stale info)") {
        "git.nonFastForward"
    } else if has("index.lock") || (has(".lock") && has("file exists")) {
        "git.indexLock"
    } else if has("not a git repository") {
        "git.notARepo"
    } else if has("could not resolve host")
        || has("connection timed out")
        || has("failed to connect")
        || has("connection refused")
        || has("network is unreachable")
        || has("could not read from remote repository")
    {
        "git.network"
    } else if has("would be overwritten by") || has("please commit your changes or stash them") {
        "git.localChangesOverwritten"
    } else if has("is not fully merged") {
        "git.branchNotMerged"
    } else if has("automatic merge failed")
        || has("could not apply")
        || has("resolve all conflicts")
        || has("merge conflict in")
        || has("conflict (")
    {
        "git.conflict"
    } else if has("nothing to commit") || has("nothing added to commit") {
        "git.nothingToCommit"
    } else if has("no tracking information") || has("no upstream") {
        "git.noUpstream"
    } else if has("already exists") {
        "git.alreadyExists"
    } else if has("not a valid branch name") || has("is not a valid branch name") {
        "git.invalidBranchName"
    } else {
        "git.failed"
    };
    AppError::new(code).detail(truncate(stderr.trim(), 8000))
}

fn quote_for_log(arg: &str) -> String {
    if arg.is_empty() || arg.chars().any(|c| c.is_whitespace() || c == '"' || c == '\'') {
        format!("\"{}\"", arg.replace('"', "\\\""))
    } else {
        arg.to_string()
    }
}

pub fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &s[..end])
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 探测 git 可执行文件：用户指定 → 常见安装位置 → PATH 中的 git。
/// macOS 下优先 Homebrew，避免 /usr/bin/git 在未装 CLT 时弹出安装窗口。
pub fn detect_git(configured: Option<&str>) -> PathBuf {
    if let Some(p) = configured.filter(|p| !p.trim().is_empty()) {
        return PathBuf::from(p.trim());
    }
    let candidates: &[&str] = if cfg!(target_os = "macos") {
        &["/opt/homebrew/bin/git", "/usr/local/bin/git", "/usr/bin/git"]
    } else if cfg!(windows) {
        &[
            r"C:\Program Files\Git\cmd\git.exe",
            r"C:\Program Files (x86)\Git\cmd\git.exe",
        ]
    } else {
        &["/usr/bin/git", "/usr/local/bin/git"]
    };
    for c in candidates {
        if Path::new(c).is_file() {
            return PathBuf::from(c);
        }
    }
    PathBuf::from(if cfg!(windows) { "git.exe" } else { "git" })
}

/// 把路径列表拆成多批，避免超出命令行长度限制（Windows 约 32K 字符）。
pub fn chunk_paths(paths: &[String]) -> Vec<Vec<String>> {
    const MAX_CHARS: usize = 8000;
    let mut out = Vec::new();
    let mut cur = Vec::new();
    let mut len = 0;
    for p in paths {
        if !cur.is_empty() && len + p.len() + 1 > MAX_CHARS {
            out.push(std::mem::take(&mut cur));
            len = 0;
        }
        len += p.len() + 1;
        cur.push(p.clone());
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percent() {
        assert_eq!(parse_percent("Receiving objects:  45% (450/1000)"), Some(45));
        assert_eq!(parse_percent("Counting objects: 100% (3/3), done."), Some(100));
        assert_eq!(parse_percent("remote: Enumerating objects"), None);
    }

    #[test]
    fn classify_errors() {
        let e = classify(" ! [rejected]        main -> main (non-fast-forward)\nerror: failed to push", "");
        assert_eq!(e.code, "git.nonFastForward");
        let e = classify("fatal: Authentication failed for 'https://github.com/a/b.git/'", "");
        assert_eq!(e.code, "git.authFailed");
        let e = classify(
            "fatal: Unable to create '/r/.git/index.lock': File exists.",
            "",
        );
        assert_eq!(e.code, "git.indexLock");
        let e = classify("", "CONFLICT (content): Merge conflict in a.txt\nAutomatic merge failed");
        assert_eq!(e.code, "git.conflict");
    }

    #[test]
    fn chunks() {
        let paths: Vec<String> = (0..1000).map(|i| format!("dir/file-{:04}.txt", i)).collect();
        let chunks = chunk_paths(&paths);
        assert!(chunks.len() > 1);
        assert_eq!(chunks.iter().map(|c| c.len()).sum::<usize>(), 1000);
    }
}
