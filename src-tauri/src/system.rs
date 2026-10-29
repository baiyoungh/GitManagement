//! 与操作系统相关的功能：扫描目录发现仓库（R-03）、在外部打开（R-08）。

use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;

/// 扫描时跳过的目录（依赖/构建产物，通常很大且不会包含要管理的仓库）
const SKIP_DIRS: &[&str] = &["node_modules", "target", "build", "dist", ".gradle", ".idea", "Pods", "vendor", ".venv", "venv", "__pycache__"];
const SCAN_LIMIT: usize = 2000;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FoundRepo {
    pub path: String,
    pub name: String,
    /// .git 是文件（worktree / submodule）
    pub linked: bool,
}

/// 递归发现 git 仓库（R-03）。找到仓库后不再深入其内部（子模块由 M4 处理）。
/// depth=1 表示只检查 root 的直接子目录；root 自身是仓库时也会返回。
pub fn scan_repos(root: &Path, depth: u32) -> AppResult<(Vec<FoundRepo>, bool)> {
    if !root.is_dir() {
        return Err(AppError::new("path.invalid").param("path", root.display()));
    }
    let mut out = Vec::new();
    let mut truncated = false;
    walk(root, 0, depth.clamp(1, 8), &mut out, &mut truncated);
    out.sort_by(|a, b| a.path.to_lowercase().cmp(&b.path.to_lowercase()));
    Ok((out, truncated))
}

fn walk(dir: &Path, level: u32, max: u32, out: &mut Vec<FoundRepo>, truncated: &mut bool) {
    if out.len() >= SCAN_LIMIT {
        *truncated = true;
        return;
    }
    let dotgit = dir.join(".git");
    if dotgit.exists() {
        out.push(FoundRepo {
            path: dir.display().to_string(),
            name: dir.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default(),
            linked: dotgit.is_file(),
        });
        return;
    }
    if level >= max {
        return;
    }
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    let mut subs: Vec<PathBuf> = rd
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().map(|t| t.is_dir() && !t.is_symlink()).unwrap_or(false))
        .map(|e| e.path())
        .filter(|p| {
            let n = p.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
            !(n.starts_with('.') || SKIP_DIRS.contains(&n.as_str()))
        })
        .collect();
    subs.sort();
    for s in subs {
        walk(&s, level + 1, max, out, truncated);
    }
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum OpenTarget {
    /// Finder / 资源管理器
    FileManager,
    /// 在文件管理器中选中某个文件
    Reveal,
    Terminal,
    /// 设置中配置的 IDE / 编辑器
    Editor,
}

/// 在外部打开（R-08）。`app` 为用户配置的终端或编辑器：
/// macOS 填应用名（如 "iTerm"、"Visual Studio Code"），Windows/Linux 填可执行文件路径或命令名。
pub fn open_external(path: &Path, target: OpenTarget, app: Option<&str>) -> AppResult<()> {
    if !path.exists() {
        return Err(AppError::new("path.invalid").param("path", path.display()));
    }
    let app = app.map(str::trim).filter(|s| !s.is_empty());
    let mut cmd = build_command(path, target, app)?;
    cmd.spawn()
        .map(|_| ())
        .map_err(|e| AppError::new("open.failed").param("path", path.display()).detail(e.to_string()))
}

#[cfg(target_os = "macos")]
fn build_command(path: &Path, target: OpenTarget, app: Option<&str>) -> AppResult<Command> {
    let mut c = Command::new("open");
    match target {
        OpenTarget::FileManager => {
            c.arg(path);
        }
        OpenTarget::Reveal => {
            c.arg("-R").arg(path);
        }
        OpenTarget::Terminal => {
            c.arg("-a").arg(app.unwrap_or("Terminal")).arg(path);
        }
        OpenTarget::Editor => {
            let a = app.ok_or_else(|| AppError::new("open.noEditor"))?;
            c.arg("-a").arg(a).arg(path);
        }
    }
    Ok(c)
}

#[cfg(target_os = "windows")]
fn build_command(path: &Path, target: OpenTarget, app: Option<&str>) -> AppResult<Command> {
    use std::os::windows::process::CommandExt;
    let dir = if path.is_dir() { path.to_path_buf() } else { path.parent().map(Path::to_path_buf).unwrap_or_default() };
    let mut c = match target {
        OpenTarget::FileManager => {
            let mut c = Command::new("explorer");
            c.arg(path);
            c
        }
        OpenTarget::Reveal => {
            let mut c = Command::new("explorer");
            // /select,<path> 必须作为一个参数，不能有空格分隔
            c.raw_arg(format!("/select,\"{}\"", path.display()));
            c
        }
        OpenTarget::Terminal => match app {
            Some(a) => {
                let mut c = Command::new(a);
                c.current_dir(&dir);
                c
            }
            None => {
                // 优先 Windows Terminal，未安装时退回 cmd
                if which("wt.exe").is_some() {
                    let mut c = Command::new("wt.exe");
                    c.arg("-d").arg(&dir);
                    c
                } else {
                    let mut c = Command::new("cmd.exe");
                    c.args(["/c", "start", "", "cmd.exe"]).current_dir(&dir);
                    c
                }
            }
        },
        OpenTarget::Editor => {
            let a = app.ok_or_else(|| AppError::new("open.noEditor"))?;
            let mut c = Command::new(a);
            c.arg(path);
            c
        }
    };
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    if target != OpenTarget::Terminal {
        c.creation_flags(CREATE_NO_WINDOW);
    }
    Ok(c)
}

#[cfg(target_os = "windows")]
fn which(exe: &str) -> Option<PathBuf> {
    std::env::var_os("PATH").and_then(|p| std::env::split_paths(&p).map(|d| d.join(exe)).find(|f| f.is_file()))
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn build_command(path: &Path, target: OpenTarget, app: Option<&str>) -> AppResult<Command> {
    let dir = if path.is_dir() { path.to_path_buf() } else { path.parent().map(Path::to_path_buf).unwrap_or_default() };
    Ok(match target {
        OpenTarget::FileManager => {
            let mut c = Command::new("xdg-open");
            c.arg(path);
            c
        }
        OpenTarget::Reveal => {
            let mut c = Command::new("xdg-open");
            c.arg(&dir);
            c
        }
        OpenTarget::Terminal => {
            let mut c = Command::new(app.unwrap_or("x-terminal-emulator"));
            c.current_dir(&dir);
            c
        }
        OpenTarget::Editor => {
            let a = app.ok_or_else(|| AppError::new("open.noEditor"))?;
            let mut c = Command::new(a);
            c.arg(path);
            c
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scans_nested_repos() {
        let d = tempfile::tempdir().unwrap();
        let root = d.path();
        for p in ["a/.git", "group/b/.git", "group/deep/x/c/.git", "node_modules/pkg/.git", ".hidden/r/.git", "a/inner/.git"] {
            std::fs::create_dir_all(root.join(p)).unwrap();
        }
        std::fs::create_dir_all(root.join("wt")).unwrap();
        std::fs::write(root.join("wt/.git"), "gitdir: ../a/.git/worktrees/wt").unwrap();

        let (found, truncated) = scan_repos(root, 2).unwrap();
        let names: Vec<&str> = found.iter().map(|f| f.name.as_str()).collect();
        assert!(!truncated);
        // a/inner 在仓库 a 内部，不再深入；deep/x/c 超过深度；node_modules 与隐藏目录跳过
        assert_eq!(names, vec!["a", "b", "wt"]);
        assert!(found[2].linked);

        let (found, _) = scan_repos(root, 4).unwrap();
        assert_eq!(found.len(), 4);
        // 根目录本身是仓库
        let (found, _) = scan_repos(&root.join("a"), 3).unwrap();
        assert_eq!(found.len(), 1);
    }
}
