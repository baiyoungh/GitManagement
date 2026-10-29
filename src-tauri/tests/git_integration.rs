//! 集成测试：在临时目录用真实 git 构造场景，覆盖 M1 验收标准（specs/08）。
//! 运行：cargo test --manifest-path src-tauri/Cargo.toml
//! 需要本机安装 git ≥ 2.30。

use gitmanagement_lib::git::branch::{self, CheckoutMode};
use gitmanagement_lib::git::changes::{self, CommitRequest, RollbackOpts};
use gitmanagement_lib::git::parse::ChangeKind;
use gitmanagement_lib::git::runner::{detect_git, CancelToken, GitRunner, RunOpts};
use gitmanagement_lib::git::status::status;
use gitmanagement_lib::git::sync::{self, PushReq};
use gitmanagement_lib::git::Repo;
use std::fs;
use std::path::Path;

fn runner() -> GitRunner {
    GitRunner::new(detect_git(None))
}

fn git(r: &GitRunner, dir: &Path, args: &[&str]) {
    r.run(dir, args, &RunOpts::default()).unwrap_or_else(|e| panic!("git {:?}: {}", args, e));
}

/// 带中文与空格路径的仓库，含一个初始提交
fn setup(r: &GitRunner) -> tempfile::TempDir {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("中文 仓库");
    fs::create_dir_all(&dir).unwrap();
    git(r, &dir, &["init", "-q", "-b", "main"]);
    git(r, &dir, &["config", "user.name", "Test"]);
    git(r, &dir, &["config", "user.email", "test@example.com"]);
    git(r, &dir, &["config", "commit.gpgsign", "false"]);
    fs::write(dir.join("a.txt"), "a\n").unwrap();
    fs::write(dir.join("文件 b.txt"), "b\n").unwrap();
    fs::write(dir.join("c.txt"), "c\n").unwrap();
    git(r, &dir, &["add", "-A"]);
    git(r, &dir, &["commit", "-q", "-m", "init"]);
    tmp
}

fn repo_dir(tmp: &tempfile::TempDir) -> std::path::PathBuf {
    tmp.path().join("中文 仓库")
}

fn committed_files(r: &GitRunner, dir: &Path) -> Vec<String> {
    let out = r
        .run(dir, &["show", "--name-only", "--format=", "HEAD"], &RunOpts::read())
        .unwrap();
    let mut v: Vec<String> = out.text().lines().filter(|l| !l.is_empty()).map(String::from).collect();
    v.sort();
    v
}

fn req(files: &[&str], msg: &str) -> CommitRequest {
    CommitRequest {
        files: files.iter().map(|s| s.to_string()).collect(),
        message: msg.into(),
        amend: false,
        signoff: false,
        author: None,
        no_verify: false,
        staging_mode: false,
        partial: vec![],
    }
}

#[test]
fn commit_only_checked_files() {
    let r = runner();
    let tmp = setup(&r);
    let dir = repo_dir(&tmp);
    let repo = Repo::new(&r, &dir);
    fs::write(dir.join("a.txt"), "a2\n").unwrap();
    fs::write(dir.join("文件 b.txt"), "b2\n").unwrap();
    fs::write(dir.join("c.txt"), "c2\n").unwrap();

    // 勾选 3 个文件中的 2 个
    changes::commit(&repo, &req(&["a.txt", "文件 b.txt"], "feat: two")).unwrap();
    assert_eq!(committed_files(&r, &dir), vec!["a.txt", "文件 b.txt"]);

    let st = status(&repo, false).unwrap();
    assert_eq!(st.files.len(), 1);
    assert_eq!(st.files[0].path, "c.txt");
}

#[test]
fn pre_staged_unchecked_file_is_not_committed() {
    let r = runner();
    let tmp = setup(&r);
    let dir = repo_dir(&tmp);
    let repo = Repo::new(&r, &dir);
    fs::write(dir.join("a.txt"), "a2\n").unwrap();
    fs::write(dir.join("c.txt"), "c2\n").unwrap();
    // 命令行事先 git add 了未勾选的文件
    git(&r, &dir, &["add", "c.txt"]);

    changes::commit(&repo, &req(&["a.txt"], "fix: only a")).unwrap();
    assert_eq!(committed_files(&r, &dir), vec!["a.txt"]);
    // c.txt 的改动仍保留在工作区
    assert_eq!(fs::read_to_string(dir.join("c.txt")).unwrap(), "c2\n");
}

#[test]
fn commit_new_and_deleted_files() {
    let r = runner();
    let tmp = setup(&r);
    let dir = repo_dir(&tmp);
    let repo = Repo::new(&r, &dir);
    fs::write(dir.join("new file.txt"), "n\n").unwrap();
    fs::remove_file(dir.join("c.txt")).unwrap();
    changes::commit(&repo, &req(&["new file.txt", "c.txt"], "chore: add+del")).unwrap();
    assert_eq!(committed_files(&r, &dir), vec!["c.txt", "new file.txt"]);
    assert!(status(&repo, false).unwrap().files.is_empty());
}

#[test]
fn failed_hook_restores_index() {
    let r = runner();
    let tmp = setup(&r);
    let dir = repo_dir(&tmp);
    let repo = Repo::new(&r, &dir);
    let hook = dir.join(".git/hooks/pre-commit");
    fs::write(&hook, "#!/bin/sh\necho 'hook says no' >&2\nexit 1\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
    }
    fs::write(dir.join("a.txt"), "a2\n").unwrap();
    fs::write(dir.join("c.txt"), "c2\n").unwrap();
    git(&r, &dir, &["add", "c.txt"]);

    let err = changes::commit(&repo, &req(&["a.txt"], "x")).unwrap_err();
    assert!(err.detail.unwrap_or_default().contains("hook says no"));
    // index 恢复为提交前：c.txt 仍是已暂存，a.txt 未暂存
    let st = status(&repo, false).unwrap();
    let c = st.files.iter().find(|f| f.path == "c.txt").unwrap();
    let a = st.files.iter().find(|f| f.path == "a.txt").unwrap();
    assert!(c.staged);
    assert!(!a.staged);
}

#[test]
fn rollback_modified_deleted_added_untracked() {
    let r = runner();
    let tmp = setup(&r);
    let dir = repo_dir(&tmp);
    let repo = Repo::new(&r, &dir);
    fs::write(dir.join("a.txt"), "changed\n").unwrap();
    fs::remove_file(dir.join("文件 b.txt")).unwrap();
    fs::write(dir.join("added.txt"), "x\n").unwrap();
    git(&r, &dir, &["add", "added.txt"]);
    fs::write(dir.join("untracked.txt"), "u\n").unwrap();

    let paths: Vec<String> = ["a.txt", "文件 b.txt", "added.txt"].iter().map(|s| s.to_string()).collect();
    let res = changes::rollback(&repo, &paths, &RollbackOpts { delete_added: false, delete_untracked: false }).unwrap();
    assert_eq!(fs::read_to_string(dir.join("a.txt")).unwrap(), "a\n");
    assert!(dir.join("文件 b.txt").exists());
    // 新增文件取消跟踪但保留在磁盘
    assert!(dir.join("added.txt").exists());
    assert_eq!(res.trashed.len(), 0);

    let st = status(&repo, false).unwrap();
    let kinds: Vec<_> = st.files.iter().map(|f| (f.path.as_str(), f.kind)).collect();
    assert!(kinds.contains(&("added.txt", ChangeKind::Untracked)));
    assert!(kinds.contains(&("untracked.txt", ChangeKind::Untracked)));
    assert_eq!(st.files.len(), 2);
}

#[test]
fn ignore_writes_escaped_pattern() {
    let r = runner();
    let tmp = setup(&r);
    let dir = repo_dir(&tmp);
    let repo = Repo::new(&r, &dir);
    fs::write(dir.join("debug [1].log"), "x\n").unwrap();
    changes::ignore(&repo, &["debug [1].log".to_string()], changes::IgnoreTarget::Gitignore).unwrap();
    let st = status(&repo, false).unwrap();
    // .gitignore 本身成为未跟踪文件，被忽略的文件不再出现
    assert!(st.files.iter().all(|f| f.path != "debug [1].log"));
}

#[test]
fn smart_checkout_keeps_changes() {
    let r = runner();
    let tmp = setup(&r);
    let dir = repo_dir(&tmp);
    let repo = Repo::new(&r, &dir);
    git(&r, &dir, &["branch", "other"]);
    git(&r, &dir, &["switch", "-q", "other"]);
    fs::write(dir.join("a.txt"), "other\n").unwrap();
    git(&r, &dir, &["commit", "-q", "-am", "other"]);
    git(&r, &dir, &["switch", "-q", "main"]);
    fs::write(dir.join("c.txt"), "local\n").unwrap();

    let res = branch::checkout(&repo, "other", CheckoutMode::Smart).unwrap();
    assert!(!res.stash_conflict);
    assert_eq!(branch::current(&repo).as_deref(), Some("other"));
    assert_eq!(fs::read_to_string(dir.join("c.txt")).unwrap(), "local\n");
}

#[test]
fn push_rejected_is_classified() {
    let r = runner();
    let tmp = setup(&r);
    let dir = repo_dir(&tmp);
    let bare = tmp.path().join("remote.git");
    git(&r, tmp.path(), &["init", "-q", "--bare", "-b", "main", bare.to_str().unwrap()]);
    git(&r, &dir, &["remote", "add", "origin", bare.to_str().unwrap()]);
    git(&r, &dir, &["push", "-q", "-u", "origin", "main"]);

    // 另一个克隆推送新提交，使本地落后
    let other = tmp.path().join("other");
    git(&r, tmp.path(), &["clone", "-q", bare.to_str().unwrap(), other.to_str().unwrap()]);
    git(&r, &other, &["config", "user.name", "O"]);
    git(&r, &other, &["config", "user.email", "o@example.com"]);
    git(&r, &other, &["config", "commit.gpgsign", "false"]);
    fs::write(other.join("a.txt"), "remote\n").unwrap();
    git(&r, &other, &["commit", "-q", "-am", "remote change"]);
    git(&r, &other, &["push", "-q"]);

    let repo = Repo::new(&r, &dir);
    fs::write(dir.join("c.txt"), "local\n").unwrap();
    changes::commit(&repo, &req(&["c.txt"], "local")).unwrap();

    let err = sync::push(
        &repo,
        &PushReq {
            branch: "main".into(),
            remote: "origin".into(),
            remote_branch: "main".into(),
            force: false,
            tags: false,
            set_upstream: false,
        },
        &CancelToken::new(),
        None,
    )
    .unwrap_err();
    assert_eq!(err.code, "git.nonFastForward");

    // 推送预览能看到落后数
    sync::fetch(&repo, Some("origin"), &CancelToken::new(), None).unwrap();
    let p = sync::push_preview(&repo, None, None, None).unwrap();
    assert_eq!(p.behind, 1);
    assert_eq!(p.commits.len(), 1);
}

#[test]
fn branch_list_and_upstream() {
    let r = runner();
    let tmp = setup(&r);
    let dir = repo_dir(&tmp);
    let repo = Repo::new(&r, &dir);
    git(&r, &dir, &["remote", "add", "origin", "https://example.invalid/x.git"]);
    branch::set_upstream_config(&repo, "main", "origin", "main").unwrap();
    let list = branch::list(&repo).unwrap();
    let main = list.iter().find(|b| b.name == "main").unwrap();
    assert!(main.is_head);
    assert_eq!(main.upstream_remote.as_deref(), Some("origin"));
    branch::unset_upstream(&repo, "main").unwrap();
    let list = branch::list(&repo).unwrap();
    assert!(list.iter().find(|b| b.name == "main").unwrap().upstream.is_none());
}
