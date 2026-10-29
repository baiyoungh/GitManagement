//! M3 集成测试：部分提交、Stash、标签、分支比较、文件历史与 Blame、日志过滤、提交前检查。

use gitmanagement_lib::git::changes::{self, CommitRequest};
use gitmanagement_lib::git::log::{self, LogQuery};
use gitmanagement_lib::git::partial::{HunkSelection, PartialFile};
use gitmanagement_lib::git::precheck::{self, IssueKind, PrecheckOpts};
use gitmanagement_lib::git::runner::{detect_git, CancelToken, GitRunner, RunOpts};
use gitmanagement_lib::git::stash::{self, StashCreateReq};
use gitmanagement_lib::git::status::status;
use gitmanagement_lib::git::Repo;
use std::fs;
use std::path::Path;

fn runner() -> GitRunner {
    GitRunner::new(detect_git(None))
}

fn git(r: &GitRunner, dir: &Path, args: &[&str]) -> String {
    r.run(dir, args, &RunOpts::default()).unwrap_or_else(|e| panic!("git {:?}: {}", args, e)).text()
}

fn init_repo(r: &GitRunner, dir: &Path) {
    fs::create_dir_all(dir).unwrap();
    git(r, dir, &["init", "-q", "-b", "main"]);
    git(r, dir, &["config", "user.name", "Test"]);
    git(r, dir, &["config", "user.email", "t@example.com"]);
    git(r, dir, &["config", "commit.gpgsign", "false"]);
}

fn commit_all(r: &GitRunner, dir: &Path, msg: &str) {
    git(r, dir, &["add", "-A"]);
    git(r, dir, &["commit", "-q", "-m", msg]);
}

fn req(files: &[&str], partial: Vec<PartialFile>, msg: &str) -> CommitRequest {
    CommitRequest {
        files: files.iter().map(|s| s.to_string()).collect(),
        message: msg.into(),
        amend: false,
        signoff: false,
        author: None,
        no_verify: false,
        staging_mode: false,
        partial,
    }
}

fn sel(os: u32, ol: u32, ns: u32, nl: u32) -> HunkSelection {
    HunkSelection { old_start: os, old_lines: ol, new_start: ns, new_lines: nl, removed: None, added: None }
}

#[test]
fn partial_commit_hunks_and_lines() {
    let r = runner();
    let d = tempfile::tempdir().unwrap();
    let dir = d.path().join("中文 仓库");
    init_repo(&r, &dir);
    fs::write(dir.join("a b.txt"), "1\n2\n3\n4\n5\n6\n7\n8\n9\n").unwrap();
    commit_all(&r, &dir, "init");
    // 两个 hunk：第 2 行修改、末尾新增两行
    fs::write(dir.join("a b.txt"), "1\nTWO\n3\n4\n5\n6\n7\n8\n9\n10\n11\n").unwrap();
    fs::write(dir.join("other.txt"), "x\n").unwrap();
    let repo = Repo::new(&r, &dir);

    // 只提交第一个 hunk
    changes::commit(&repo, &req(&[], vec![PartialFile { path: "a b.txt".into(), hunks: vec![sel(2, 1, 2, 1)] }], "first hunk")).unwrap();
    assert_eq!(git(&r, &dir, &["show", "HEAD:a b.txt"]), "1\nTWO\n3\n4\n5\n6\n7\n8\n9\n");
    // 工作区不变，剩余改动仍在
    assert_eq!(fs::read_to_string(dir.join("a b.txt")).unwrap(), "1\nTWO\n3\n4\n5\n6\n7\n8\n9\n10\n11\n");
    let st = status(&repo, false).unwrap();
    assert!(st.files.iter().any(|f| f.path == "a b.txt"));
    // 未勾选的未跟踪文件不进入提交
    assert!(r.exec(&dir, &["cat-file", "-e", "HEAD:other.txt"], &RunOpts::read()).unwrap().code != 0);

    // 行级：新增的两行只提交第 10 行
    let mut h = sel(9, 0, 10, 2);
    h.added = Some(vec![10]);
    changes::commit(&repo, &req(&["other.txt"], vec![PartialFile { path: "a b.txt".into(), hunks: vec![h] }], "line")).unwrap();
    assert_eq!(git(&r, &dir, &["show", "HEAD:a b.txt"]), "1\nTWO\n3\n4\n5\n6\n7\n8\n9\n10\n");
    assert_eq!(git(&r, &dir, &["show", "HEAD:other.txt"]), "x\n");

    // 未跟踪新文件的部分提交
    fs::write(dir.join("new.txt"), "a\nb\n").unwrap();
    let mut h = sel(0, 0, 1, 2);
    h.added = Some(vec![1]);
    changes::commit(&repo, &req(&[], vec![PartialFile { path: "new.txt".into(), hunks: vec![h] }], "new partial")).unwrap();
    assert_eq!(git(&r, &dir, &["show", "HEAD:new.txt"]), "a\n");

    // 同一文件不能既整文件勾选又部分勾选
    let bad = req(&["a b.txt"], vec![PartialFile { path: "a b.txt".into(), hunks: vec![] }], "x");
    assert_eq!(changes::commit(&repo, &bad).unwrap_err().code, "partial.unsupported");
}

#[test]
fn partial_commit_preserves_crlf() {
    let r = runner();
    let d = tempfile::tempdir().unwrap();
    let dir = d.path().join("crlf");
    init_repo(&r, &dir);
    git(&r, &dir, &["config", "core.autocrlf", "false"]);
    fs::write(dir.join("w.txt"), "a\r\nb\r\nc").unwrap();
    commit_all(&r, &dir, "init");
    fs::write(dir.join("w.txt"), "A\r\nb\r\nc\r\nd").unwrap();
    let repo = Repo::new(&r, &dir);
    // hunk1 -1 +1 ；hunk2 -3 +3,2（无结尾换行的最后一行变化）
    changes::commit(&repo, &req(&[], vec![PartialFile { path: "w.txt".into(), hunks: vec![sel(3, 1, 3, 2)] }], "tail")).unwrap();
    assert_eq!(git(&r, &dir, &["show", "HEAD:w.txt"]), "a\r\nb\r\nc\r\nd");
}

#[test]
fn stash_lifecycle() {
    let r = runner();
    let d = tempfile::tempdir().unwrap();
    let dir = d.path().join("s");
    init_repo(&r, &dir);
    fs::write(dir.join("a.txt"), "1\n").unwrap();
    fs::write(dir.join("b.txt"), "1\n").unwrap();
    commit_all(&r, &dir, "init");
    let repo = Repo::new(&r, &dir);

    // 只 stash 选中文件
    fs::write(dir.join("a.txt"), "2\n").unwrap();
    fs::write(dir.join("b.txt"), "2\n").unwrap();
    stash::create(&repo, &StashCreateReq { message: "只有 a".into(), paths: vec!["a.txt".into()], ..Default::default() }).unwrap();
    assert_eq!(fs::read_to_string(dir.join("a.txt")).unwrap(), "1\n");
    assert_eq!(fs::read_to_string(dir.join("b.txt")).unwrap(), "2\n");

    // 包含未跟踪文件
    fs::write(dir.join("u.txt"), "u\n").unwrap();
    stash::create(&repo, &StashCreateReq { message: "all".into(), include_untracked: true, ..Default::default() }).unwrap();
    assert!(!dir.join("u.txt").exists());
    let list = stash::list(&repo).unwrap();
    assert_eq!(list.len(), 2);
    assert_eq!(list[0].message, "On main: all");
    assert_eq!(list[0].branch.as_deref(), Some("main"));
    assert!(list[0].has_untracked);
    let files = stash::files(&repo, &list[0].hash).unwrap();
    assert!(files.iter().any(|f| f.file.path == "b.txt" && !f.untracked));
    assert!(files.iter().any(|f| f.file.path == "u.txt" && f.untracked));

    // 没有改动时提示
    assert_eq!(stash::create(&repo, &StashCreateReq::default()).unwrap_err().code, "stash.nothing");

    // 按哈希 pop 第二条（stash@{1}），列表序号变化不影响
    let a_hash = list[1].hash.clone();
    let res = stash::apply(&repo, &a_hash, true, false).unwrap();
    assert!(!res.conflicts);
    assert_eq!(fs::read_to_string(dir.join("a.txt")).unwrap(), "2\n");
    assert_eq!(stash::list(&repo).unwrap().len(), 1);

    // 冲突：工作区改 b.txt 后提交，再 apply 修改了 b 的 stash
    fs::write(dir.join("b.txt"), "3\n").unwrap();
    commit_all(&r, &dir, "b3");
    let all_hash = stash::list(&repo).unwrap()[0].hash.clone();
    let res = stash::apply(&repo, &all_hash, false, false).unwrap();
    assert!(res.conflicts);
    git(&r, &dir, &["checkout", "--theirs", "--", "b.txt"]);
    git(&r, &dir, &["reset", "-q", "--hard"]);
    git(&r, &dir, &["clean", "-fdq"]);

    // 从 stash 建分支（基于 stash 的基础提交，成功后 stash 被删除）
    stash::branch(&repo, &all_hash, "from-stash").unwrap();
    assert_eq!(git(&r, &dir, &["rev-parse", "--abbrev-ref", "HEAD"]).trim(), "from-stash");
    assert_eq!(fs::read_to_string(dir.join("b.txt")).unwrap(), "2\n");
    assert!(dir.join("u.txt").exists());
    assert!(stash::list(&repo).unwrap().is_empty());
    assert_eq!(stash::drop(&repo, &all_hash).unwrap_err().code, "stash.notFound");
}

#[test]
fn tags_compare_history_blame_filters() {
    let r = runner();
    let d = tempfile::tempdir().unwrap();
    let root = d.path();
    let dir = root.join("w");
    init_repo(&r, &dir);
    fs::write(dir.join("f.txt"), "a\nb\n").unwrap();
    commit_all(&r, &dir, "one");
    git(&r, &dir, &["mv", "f.txt", "g h.txt"]);
    commit_all(&r, &dir, "two: rename");
    fs::write(dir.join("g h.txt"), "a\nb\nc\n").unwrap();
    commit_all(&r, &dir, "three");
    let repo = Repo::new(&r, &dir);

    // 文件历史跟踪重命名
    let (h, more) = log::file_history(&repo, "g h.txt", 0, None).unwrap();
    assert!(!more);
    assert_eq!(h.iter().map(|e| e.commit.subject.as_str()).collect::<Vec<_>>(), vec!["three", "two: rename", "one"]);
    assert_eq!(h[1].status, "R");
    assert_eq!(h[2].path, "f.txt");

    // Blame：工作区未提交的行显示为未提交
    fs::write(dir.join("g h.txt"), "a\nb\nc\nd\n").unwrap();
    let b = log::blame(&repo, "g h.txt", None).unwrap();
    assert_eq!(b.lines.len(), 4);
    let c_of = |i: usize| b.commits.iter().find(|c| c.hash == b.lines[i].hash).unwrap();
    assert_eq!(c_of(0).summary, "one");
    assert_eq!(c_of(2).summary, "three");
    assert!(c_of(3).uncommitted);
    git(&r, &dir, &["checkout", "--", "g h.txt"]);

    // 分支比较
    git(&r, &dir, &["checkout", "-q", "-b", "feature"]);
    fs::write(dir.join("feat.txt"), "f\n").unwrap();
    commit_all(&r, &dir, "feat");
    git(&r, &dir, &["checkout", "-q", "main"]);
    fs::write(dir.join("main.txt"), "m\n").unwrap();
    commit_all(&r, &dir, "main only");
    let cmp = log::compare_refs(&repo, "main", "feature").unwrap();
    assert_eq!(cmp.only_right.len(), 1);
    assert_eq!(cmp.only_right[0].subject, "feat");
    assert_eq!(cmp.only_left[0].subject, "main only");
    let mut paths: Vec<_> = cmp.files.iter().map(|f| (f.status.as_str(), f.path.as_str())).collect();
    paths.sort();
    assert_eq!(paths, vec![("A", "feat.txt"), ("D", "main.txt")]);
    // 与工作区比较
    fs::write(dir.join("main.txt"), "changed\n").unwrap();
    let wt = log::compare_files(&repo, "feature", None).unwrap();
    assert!(wt.iter().any(|f| f.path == "main.txt" && f.status == "A"));
    git(&r, &dir, &["checkout", "--", "main.txt"]);

    // 日志过滤：作者、路径、日期
    let q = |f: &dyn Fn(&mut LogQuery)| {
        let mut q = LogQuery::default();
        f(&mut q);
        log::log(&repo, &q).unwrap().commits.len()
    };
    assert_eq!(q(&|q| q.author = Some("TEST".into())), 5);
    assert_eq!(q(&|q| q.author = Some("nobody".into())), 0);
    assert_eq!(q(&|q| q.paths = vec!["feat.txt".into()]), 1);
    assert_eq!(q(&|q| q.until = Some("2000-01-01".into())), 0);
    assert_eq!(q(&|q| q.since = Some("2000-01-01".into())), 5);
    assert!(log::log(&repo, &LogQuery { since: Some("昨天".into()), ..Default::default() }).is_err());

    // 标签：新建、列表、推送、删除
    let head = git(&r, &dir, &["rev-parse", "HEAD"]).trim().to_string();
    log::create_tag(&repo, "v1.0", &head, Some("Release")).unwrap();
    log::create_tag(&repo, "light", "feature", None).unwrap();
    let tags = log::list_tags(&repo).unwrap();
    let v1 = tags.iter().find(|t| t.name == "v1.0").unwrap();
    assert!(v1.annotated);
    assert_eq!(v1.commit, head);
    assert_eq!(v1.subject, "Release");
    let bare = root.join("remote.git");
    git(&r, root, &["init", "-q", "--bare", bare.to_str().unwrap()]);
    git(&r, &dir, &["remote", "add", "origin", bare.to_str().unwrap()]);
    let token = CancelToken::new();
    log::push_tag(&repo, "origin", Some("v1.0"), &token).unwrap();
    assert!(git(&r, &bare, &["tag"]).contains("v1.0"));
    log::push_tag(&repo, "origin", None, &token).unwrap();
    assert!(git(&r, &bare, &["tag"]).contains("light"));
    log::delete_remote_tag(&repo, "origin", "light", &token).unwrap();
    assert!(!git(&r, &bare, &["tag"]).contains("light"));
    log::delete_tag(&repo, "v1.0").unwrap();
    assert_eq!(log::list_tags(&repo).unwrap().len(), 1);

    // 二进制内容
    fs::write(dir.join("img.png"), [0x89u8, b'P', b'N', b'G', 0, 1, 2]).unwrap();
    let bd = log::blob_data(&repo, None, "img.png").unwrap();
    assert!(bd.exists);
    assert_eq!(bd.size, 7);
    assert_eq!(bd.base64.as_deref(), Some("iVBORwABAg=="));
    assert!(bd.oid.is_some());
    assert!(!log::blob_data(&repo, Some("HEAD"), "img.png").unwrap().exists);
}

#[test]
fn precheck_only_new_lines() {
    let r = runner();
    let d = tempfile::tempdir().unwrap();
    let dir = d.path().join("p");
    init_repo(&r, &dir);
    fs::write(dir.join("conf.ts"), "// TODO old\nconst a = 1;\n").unwrap();
    commit_all(&r, &dir, "init");
    fs::write(dir.join("conf.ts"), "// TODO old\nconst a = 1;\nconst k = 'AKIAABCDEFGHIJKLMNOP';\n").unwrap();
    fs::write(dir.join("big.bin"), vec![1u8; 2 * 1024 * 1024]).unwrap();
    fs::write(dir.join("new.ts"), "// FIXME later\n").unwrap();
    let repo = Repo::new(&r, &dir);
    let opts = PrecheckOpts { large_file_mb: 1, secrets: true, todo: true };
    let issues = precheck::run(&repo, &["conf.ts".into(), "big.bin".into(), "new.ts".into()], &opts).unwrap();
    let got: Vec<(IssueKind, &str, Option<u32>)> = issues.iter().map(|i| (i.kind, i.path.as_str(), i.line)).collect();
    // 已提交的 TODO 不再报警，只报新增行
    assert_eq!(
        got,
        vec![(IssueKind::Secret, "conf.ts", Some(3)), (IssueKind::LargeFile, "big.bin", None), (IssueKind::Todo, "new.ts", Some(1))]
    );
}

#[test]
fn partial_commit_with_autocrlf_and_glob_names() {
    let r = runner();
    let d = tempfile::tempdir().unwrap();
    let dir = d.path().join("acrlf");
    init_repo(&r, &dir);
    git(&r, &dir, &["config", "core.autocrlf", "true"]);
    git(&r, &dir, &["config", "core.safecrlf", "true"]);
    // 仓库内为 LF，工作区为 CRLF（Windows 常见配置）
    fs::write(dir.join("a[1].txt"), "a\r\nb\r\nc\r\n").unwrap();
    fs::write(dir.join("a1.txt"), "x\r\n").unwrap();
    commit_all(&r, &dir, "init");
    assert_eq!(git(&r, &dir, &["show", "HEAD:a[1].txt"]), "a\nb\nc\n");
    fs::write(dir.join("a[1].txt"), "A\r\nb\r\nc\r\nd\r\n").unwrap();
    let repo = Repo::new(&r, &dir);

    // 差异按工作区形式比较：只有两个 hunk，而不是整个文件
    let diff = gitmanagement_lib::git::diff::diff_file(
        &repo,
        "a[1].txt",
        None,
        &gitmanagement_lib::git::diff::Rev::Commit { rev: "HEAD".into() },
        &gitmanagement_lib::git::diff::Rev::Worktree,
        &Default::default(),
    )
    .unwrap();
    assert_eq!(diff.hunks.len(), 2);
    changes::commit(&repo, &req(&[], vec![PartialFile { path: "a[1].txt".into(), hunks: vec![sel(3, 0, 4, 1)] }], "tail")).unwrap();
    // 仓库中保持 LF，只包含选中的块
    assert_eq!(git(&r, &dir, &["show", "HEAD:a[1].txt"]), "a\nb\nc\nd\n");
    assert_eq!(git(&r, &dir, &["ls-files", "-s", "--", "a[1].txt"]).split_whitespace().next(), Some("100644"));
}

#[test]
fn failed_commit_keeps_intent_to_add() {
    let r = runner();
    let d = tempfile::tempdir().unwrap();
    let dir = d.path().join("ita");
    init_repo(&r, &dir);
    fs::write(dir.join("a.txt"), "1\n").unwrap();
    commit_all(&r, &dir, "init");
    fs::write(dir.join("new.txt"), "n\n").unwrap();
    git(&r, &dir, &["add", "-N", "new.txt"]);
    fs::write(dir.join("a.txt"), "2\n").unwrap();
    // pre-commit hook 拒绝提交
    let hook = dir.join(".git/hooks/pre-commit");
    fs::write(&hook, "#!/bin/sh\nexit 1\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
    }
    let repo = Repo::new(&r, &dir);
    assert!(changes::commit(&repo, &req(&["a.txt"], vec![], "x")).is_err());
    // new.txt 仍是 intent-to-add（已跟踪），而不是变回未跟踪
    let st = status(&repo, false).unwrap();
    let f = st.files.iter().find(|f| f.path == "new.txt").unwrap();
    assert_ne!(f.kind, gitmanagement_lib::git::parse::ChangeKind::Untracked);
}
