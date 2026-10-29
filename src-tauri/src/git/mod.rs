pub mod branch;
pub mod changes;
pub mod conflict;
pub mod diff;
pub mod log;
pub mod partial;
pub mod precheck;
pub mod remote;
pub mod stash;
pub mod parse;
pub mod runner;
pub mod status;
pub mod sync;

use crate::error::{AppError, AppResult};
use runner::{GitOutput, GitRunner, RunOpts};
use std::ffi::OsStr;
use std::path::{Component, Path, PathBuf};

/// 空树对象（SHA-1），用于尚无提交的仓库计算 numstat
pub const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/// 绑定到某个工作目录的 git 调用助手
pub struct Repo<'a> {
    pub git: &'a GitRunner,
    pub path: PathBuf,
}

impl<'a> Repo<'a> {
    pub fn new(git: &'a GitRunner, path: impl Into<PathBuf>) -> Self {
        Self { git, path: path.into() }
    }

    /// 只读查询（GIT_OPTIONAL_LOCKS=0）
    pub fn read<S: AsRef<OsStr>>(&self, args: &[S]) -> AppResult<GitOutput> {
        self.git.run(&self.path, args, &RunOpts::read())
    }

    /// 写操作，路径按字面量处理
    pub fn write<S: AsRef<OsStr>>(&self, args: &[S]) -> AppResult<GitOutput> {
        self.git.run(&self.path, args, &RunOpts::literal())
    }

    pub fn run_with<S: AsRef<OsStr>>(&self, args: &[S], opts: &RunOpts) -> AppResult<GitOutput> {
        self.git.run(&self.path, args, opts)
    }

    pub fn exec<S: AsRef<OsStr>>(&self, args: &[S], opts: &RunOpts) -> AppResult<GitOutput> {
        self.git.exec(&self.path, args, opts)
    }

    /// HEAD 指向的提交；仓库尚无提交时为 None
    pub fn head_oid(&self) -> Option<String> {
        self.exec(&["rev-parse", "--verify", "-q", "HEAD"], &RunOpts::read())
            .ok()
            .filter(|o| o.code == 0)
            .map(|o| o.trimmed())
            .filter(|s| !s.is_empty())
    }

    pub fn git_dir(&self) -> AppResult<PathBuf> {
        Ok(PathBuf::from(self.read(&["rev-parse", "--absolute-git-dir"])?.trimmed()))
    }

    /// 首个提交哈希（多个根提交时取字典序最小者），用于仓库身份识别
    pub fn root_commit(&self) -> Option<String> {
        let out = self.exec(&["rev-list", "--max-parents=0", "HEAD"], &RunOpts::read()).ok()?;
        if out.code != 0 {
            return None;
        }
        out.text().lines().map(str::trim).filter(|s| !s.is_empty()).min().map(String::from)
    }

    pub fn remotes(&self) -> AppResult<Vec<String>> {
        Ok(self
            .read(&["remote"])?
            .text()
            .lines()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(String::from)
            .collect())
    }

    /// 在仓库内安全拼接相对路径：拒绝绝对路径与 `..`，防止越界读写
    pub fn join(&self, rel: &str) -> AppResult<PathBuf> {
        safe_join(&self.path, rel)
    }
}

pub fn safe_join(root: &Path, rel: &str) -> AppResult<PathBuf> {
    let p = Path::new(rel);
    if rel.is_empty() || p.is_absolute() {
        return Err(AppError::new("path.invalid").param("path", rel));
    }
    for c in p.components() {
        match c {
            Component::Normal(_) | Component::CurDir => {}
            _ => return Err(AppError::new("path.invalid").param("path", rel)),
        }
    }
    Ok(root.join(p))
}

/// 校验从前端传入、会作为 git 参数（而非 `--` 之后的路径）的名字，防止被解析为选项
pub fn check_arg(kind: &str, value: &str) -> AppResult<()> {
    if value.is_empty() || value.starts_with('-') || value.contains('\0') {
        return Err(AppError::new("arg.invalid").param("kind", kind).param("value", value));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn join_rejects_traversal() {
        let root = Path::new("/repo");
        assert!(safe_join(root, "src/a.ts").is_ok());
        assert!(safe_join(root, "中文 目录/a b.ts").is_ok());
        assert!(safe_join(root, "../etc/passwd").is_err());
        assert!(safe_join(root, "a/../../x").is_err());
        assert!(safe_join(root, "/etc/passwd").is_err());
        assert!(safe_join(root, "").is_err());
    }

    #[test]
    fn arg_check() {
        assert!(check_arg("branch", "feature/x").is_ok());
        assert!(check_arg("branch", "--upload-pack=evil").is_err());
    }
}
