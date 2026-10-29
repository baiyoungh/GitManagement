//! 勾选提交、撤销修改、加入/忽略未跟踪文件（specs/04；C-02、C-04 ~ C-08）。

use super::parse::{ChangeKind, FileChange};
use super::runner::{chunk_paths, RunOpts};
use super::status::{status, StatusResult};
use super::Repo;
use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::io::Write;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitRequest {
    /// 勾选的文件（变更后的路径）。重命名文件会自动带上原路径。
    pub files: Vec<String>,
    pub message: String,
    #[serde(default)]
    pub amend: bool,
    #[serde(default)]
    pub signoff: bool,
    /// "Name <email>"
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub no_verify: bool,
    /// "显示暂存区"模式：不清空 index，行为与 git add 一致
    #[serde(default)]
    pub staging_mode: bool,
    /// 部分提交的文件（C-03）：只提交选中的 hunk / 行。不应同时出现在 files 中。
    #[serde(default)]
    pub partial: Vec<super::partial::PartialFile>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitResult {
    pub hash: String,
    pub short_hash: String,
    pub output: String,
}

fn run_paths(repo: &Repo, prefix: &[&str], paths: &[String]) -> AppResult<()> {
    for chunk in chunk_paths(paths) {
        let mut args: Vec<String> = prefix.iter().map(|s| s.to_string()).collect();
        args.push("--".into());
        args.extend(chunk);
        repo.write(&args)?;
    }
    Ok(())
}

/// 执行步骤见 specs/04 第 2.2 节
pub fn commit(repo: &Repo, req: &CommitRequest) -> AppResult<CommitResult> {
    // 1. 校验
    let st: StatusResult = status(repo, false)?;
    // 合并 / cherry-pick 进行中：冲突解决后的内容已在 index 中，允许不勾选文件直接提交（specs/05 第 2.4 节）
    let finishing_op = matches!(
        st.operation,
        Some(super::status::RepoOperation::Merge) | Some(super::status::RepoOperation::CherryPick) | Some(super::status::RepoOperation::Revert)
    );
    if req.files.is_empty() && req.partial.is_empty() && !req.amend && !finishing_op {
        return Err(AppError::new("commit.noFiles"));
    }
    if req.message.trim().is_empty() && !req.amend {
        return Err(AppError::new("commit.emptyMessage"));
    }
    if st.files.iter().any(|f| f.kind == ChangeKind::Conflicted) {
        return Err(AppError::new("commit.unresolvedConflicts"));
    }
    if let Some(a) = &req.author {
        if !a.trim().is_empty() && !(a.contains('<') && a.trim_end().ends_with('>')) {
            return Err(AppError::new("commit.invalidAuthor"));
        }
    }
    let selected: HashSet<&str> = req.files.iter().map(String::as_str).collect();
    let by_path = |p: &str| st.files.iter().find(|f| f.path == p);
    let mut add_paths: Vec<String> = Vec::new();
    for p in &req.files {
        let f = by_path(p).ok_or_else(|| AppError::new("commit.fileNotChanged").param("path", p))?;
        add_paths.push(f.path.clone());
        if let Some(orig) = &f.orig_path {
            add_paths.push(orig.clone());
        }
    }
    for pf in &req.partial {
        let f = by_path(&pf.path).ok_or_else(|| AppError::new("commit.fileNotChanged").param("path", &pf.path))?;
        if selected.contains(pf.path.as_str()) || f.orig_path.is_some() || !matches!(f.kind, ChangeKind::Modified | ChangeKind::Added | ChangeKind::Untracked) {
            return Err(AppError::new("partial.unsupported").param("path", &pf.path));
        }
    }
    let has_head = st.branch.oid.is_some();

    // 2. 保存 index 快照：直接复制 index 文件（write-tree 会丢失 intent-to-add 条目、stat 缓存与 skip-worktree 标记）
    let index_path = {
        let p = std::path::PathBuf::from(repo.read(&["rev-parse", "--git-path", "index"])?.trimmed());
        if p.is_absolute() { p } else { repo.path.join(p) }
    };
    let snapshot = if index_path.is_file() { Some(std::fs::read(&index_path)?) } else { None };

    let result = (|| -> AppResult<CommitResult> {
        // 3a. 清空 index 到 HEAD（合并/变基进行中时跳过，避免丢失 MERGE_HEAD 等状态）
        let reset = !req.staging_mode && st.operation.is_none();
        if reset {
            if has_head {
                repo.write(&["reset", "-q"])?;
            } else {
                repo.write(&["read-tree", "--empty"])?;
            }
            // 保留未勾选的"新增"文件的跟踪状态（intent-to-add 不会进入提交）
            let keep: Vec<String> = st
                .files
                .iter()
                .filter(|f| f.kind == ChangeKind::Added && !selected.contains(f.path.as_str()))
                .filter(|f| repo.join(&f.path).map(|p| p.exists()).unwrap_or(false))
                .map(|f| f.path.clone())
                .collect();
            if !keep.is_empty() {
                run_paths(repo, &["add", "-N"], &keep)?;
            }
        }
        // 3b. 整文件勾选 → add（git ≥ 2.0 中 add <path> 也会记录删除）
        if !add_paths.is_empty() {
            let (exists, gone): (Vec<String>, Vec<String>) = add_paths
                .iter()
                .cloned()
                .partition(|p| repo.join(p).map(|x| x.exists() || x.is_symlink()).unwrap_or(false));
            if !exists.is_empty() {
                run_paths(repo, &["add", "-f"], &exists)?;
            }
            if !gone.is_empty() {
                run_paths(repo, &["rm", "--cached", "-q", "--ignore-unmatch", "-r"], &gone)?;
            }
        }

        // 3c. 部分勾选 → 直接写入"HEAD + 选中改动"的 blob
        for pf in &req.partial {
            super::partial::stage_partial(repo, pf)?;
        }

        // 4. git commit -F <msgfile>
        let mut msg = tempfile::NamedTempFile::new()?;
        msg.write_all(req.message.as_bytes())?;
        msg.flush()?;
        let mut args: Vec<String> = vec!["commit".into()];
        if req.message.trim().is_empty() {
            args.push("--no-edit".into());
        } else {
            args.push("-F".into());
            args.push(msg.path().to_string_lossy().into_owned());
            args.push("--cleanup=strip".into());
        }
        if req.amend {
            args.push("--amend".into());
        }
        if req.signoff {
            args.push("--signoff".into());
        }
        if req.no_verify {
            args.push("--no-verify".into());
        }
        if let Some(a) = req.author.as_ref().filter(|a| !a.trim().is_empty()) {
            args.push(format!("--author={}", a.trim()));
        }
        let out = repo.run_with(&args, &RunOpts::default())?;
        // cherry-pick / revert 提交后 git 不会自动清理序列器状态，需要 --continue 收尾
        if matches!(st.operation, Some(super::status::RepoOperation::CherryPick) | Some(super::status::RepoOperation::Revert)) {
            let verb = if st.operation == Some(super::status::RepoOperation::CherryPick) { "cherry-pick" } else { "revert" };
            let _ = repo.exec(&[verb, "--continue"], &RunOpts::literal());
        }
        let hash = repo.read(&["rev-parse", "HEAD"])?.trimmed();
        Ok(CommitResult {
            short_hash: hash.chars().take(7).collect(),
            hash,
            output: format!("{}{}", out.text(), out.stderr),
        })
    })();

    if result.is_err() {
        // 6. 失败（含 pre-commit hook）：恢复 index 快照
        match &snapshot {
            Some(bytes) => {
                let _ = std::fs::write(&index_path, bytes);
            }
            None => {
                let _ = std::fs::remove_file(&index_path);
            }
        }
    }
    result
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RollbackOpts {
    /// 新增（已跟踪）文件：同时把磁盘文件移入回收站
    #[serde(default)]
    pub delete_added: bool,
    /// 未跟踪文件：移入回收站（需前端勾选确认）
    #[serde(default)]
    pub delete_untracked: bool,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RollbackResult {
    pub restored: Vec<String>,
    pub trashed: Vec<String>,
    pub skipped: Vec<String>,
}

/// 撤销修改（specs/04 第 3 节）
pub fn rollback(repo: &Repo, paths: &[String], opts: &RollbackOpts) -> AppResult<RollbackResult> {
    let st = status(repo, false)?;
    let has_head = st.branch.oid.is_some();
    let wanted: HashSet<&str> = paths.iter().map(String::as_str).collect();
    let targets: Vec<&FileChange> = st.files.iter().filter(|f| wanted.contains(f.path.as_str())).collect();

    let mut res = RollbackResult::default();
    let mut restore: Vec<String> = Vec::new();
    let mut uncache: Vec<String> = Vec::new();
    let mut to_trash: Vec<String> = Vec::new();

    for f in targets {
        match f.kind {
            ChangeKind::Conflicted | ChangeKind::Ignored => res.skipped.push(f.path.clone()),
            ChangeKind::Untracked => {
                if opts.delete_untracked {
                    to_trash.push(f.path.clone());
                } else {
                    res.skipped.push(f.path.clone());
                }
            }
            ChangeKind::Added => {
                uncache.push(f.path.clone());
                if opts.delete_added {
                    to_trash.push(f.path.clone());
                }
            }
            ChangeKind::Renamed | ChangeKind::Copied => {
                if let Some(orig) = &f.orig_path {
                    if f.kind == ChangeKind::Renamed {
                        restore.push(orig.clone());
                    }
                }
                uncache.push(f.path.clone());
                // 重命名后的文件内容移入回收站，可找回
                to_trash.push(f.path.clone());
            }
            _ if !has_head => uncache.push(f.path.clone()),
            _ => restore.push(f.path.clone()),
        }
    }

    if !uncache.is_empty() {
        run_paths(repo, &["rm", "--cached", "-q", "-r", "--ignore-unmatch"], &uncache)?;
    }
    if !restore.is_empty() {
        run_paths(repo, &["restore", "--source=HEAD", "--staged", "--worktree"], &restore)?;
        res.restored.extend(restore);
    }
    res.restored.extend(uncache.iter().filter(|p| !to_trash.contains(p)).cloned());
    if !to_trash.is_empty() {
        let abs: Vec<std::path::PathBuf> = to_trash
            .iter()
            .filter_map(|p| repo.join(p).ok())
            .filter(|p| p.exists() || p.is_symlink())
            .collect();
        if !abs.is_empty() {
            trash::delete_all(&abs).map_err(|e| AppError::new("trash.failed").detail(e.to_string()))?;
        }
        res.trashed.extend(to_trash);
    }
    Ok(res)
}

/// 加入 VCS（C-08）
pub fn add(repo: &Repo, paths: &[String]) -> AppResult<()> {
    run_paths(repo, &["add", "-f"], paths)
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum IgnoreTarget {
    Gitignore,
    Exclude,
}

/// 把仓库相对路径转为锚定到根目录、转义了通配字符的 gitignore 模式
pub fn ignore_pattern(path: &str) -> String {
    let mut out = String::from("/");
    for c in path.replace('\\', "/").chars() {
        if matches!(c, '*' | '?' | '[' | '\\' | '!' | '#') {
            out.push('\\');
        }
        out.push(c);
    }
    if out.ends_with(' ') {
        let trimmed = out.trim_end_matches(' ').to_string();
        let n = out.len() - trimmed.len();
        out = trimmed + &"\\ ".repeat(n);
    }
    out
}

/// 忽略（C-08）：写入 .gitignore 或 .git/info/exclude
pub fn ignore(repo: &Repo, paths: &[String], target: IgnoreTarget) -> AppResult<()> {
    let file = match target {
        IgnoreTarget::Gitignore => repo.path.join(".gitignore"),
        IgnoreTarget::Exclude => {
            let p = repo.git_dir()?.join("info").join("exclude");
            if let Some(parent) = p.parent() {
                std::fs::create_dir_all(parent)?;
            }
            p
        }
    };
    let existing = std::fs::read_to_string(&file).unwrap_or_default();
    let existing_lines: HashSet<&str> = existing.lines().map(str::trim_end).collect();
    let eol = if existing.contains("\r\n") { "\r\n" } else { "\n" };
    let mut add = String::new();
    if !existing.is_empty() && !existing.ends_with('\n') {
        add.push_str(eol);
    }
    let mut any = false;
    for p in paths {
        repo.join(p)?;
        let pat = ignore_pattern(p);
        if !existing_lines.contains(pat.as_str()) {
            add.push_str(&pat);
            add.push_str(eol);
            any = true;
        }
    }
    if any {
        let mut f = std::fs::OpenOptions::new().create(true).append(true).open(&file)?;
        f.write_all(add.as_bytes())?;
    }
    Ok(())
}

/// 写回工作区文件（差异视图中撤销单个 hunk、编辑右侧内容后保存）
pub fn write_worktree_file(repo: &Repo, path: &str, content: &str) -> AppResult<()> {
    let p = repo.join(path)?;
    if !p.is_file() {
        return Err(AppError::new("diff.fileNotFound").param("path", path));
    }
    std::fs::write(p, content.as_bytes())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn patterns() {
        assert_eq!(ignore_pattern("build/out.log"), "/build/out.log");
        assert_eq!(ignore_pattern("a[1]*.txt"), "/a\\[1]\\*.txt");
        assert_eq!(ignore_pattern("#x"), "/\\#x");
        assert_eq!(ignore_pattern("中文 目录/a b"), "/中文 目录/a b");
    }
}
