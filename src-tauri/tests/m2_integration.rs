//! M2 验收（specs/08）：多目标同步、primary → upstream、不一致检测、UU/AA/DU 冲突、变基连续冲突。

use gitmanagement_lib::diff3::{auto_merge, split_lines, BlockKind};
use gitmanagement_lib::git::branch::{self, IntegrateMode, OperationAction};
use gitmanagement_lib::git::changes::{self, CommitRequest};
use gitmanagement_lib::git::conflict::{self, Side};
use gitmanagement_lib::git::log::{self, LogQuery, ResetMode};
use gitmanagement_lib::git::remote::{self, RemoteInput};
use gitmanagement_lib::git::runner::{detect_git, CancelToken, GitRunner, ProgressFn, RunOpts};
use gitmanagement_lib::git::status::{status, RepoOperation};
use gitmanagement_lib::git::Repo;
use gitmanagement_lib::storage::Db;
use gitmanagement_lib::sync_engine::{self, SyncDirection, SyncRule, SyncRunReq, SyncTarget, TargetOutcome, UpstreamState};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

fn runner() -> GitRunner {
    GitRunner::new(detect_git(None))
}

fn git(r: &GitRunner, dir: &Path, args: &[&str]) -> String {
    r.run(dir, args, &RunOpts::default()).unwrap_or_else(|e| panic!("git {:?}: {}", args, e)).text()
}

fn configure(r: &GitRunner, dir: &Path) {
    git(r, dir, &["config", "user.name", "Test"]);
    git(r, dir, &["config", "user.email", "t@example.com"]);
    git(r, dir, &["config", "commit.gpgsign", "false"]);
}

fn init_repo(r: &GitRunner, dir: &Path) {
    fs::create_dir_all(dir).unwrap();
    git(r, dir, &["init", "-q", "-b", "main"]);
    configure(r, dir);
    fs::write(dir.join("a.txt"), "1\n2\n3\n").unwrap();
    git(r, dir, &["add", "-A"]);
    git(r, dir, &["commit", "-q", "-m", "init"]);
}

fn bare(r: &GitRunner, root: &Path, name: &str) -> PathBuf {
    let p = root.join(name);
    git(r, root, &["init", "-q", "--bare", "-b", "main", p.to_str().unwrap()]);
    p
}

fn commit_all(r: &GitRunner, dir: &Path, msg: &str) {
    git(r, dir, &["add", "-A"]);
    git(r, dir, &["commit", "-q", "-m", msg]);
}

fn noop_progress() -> ProgressFn {
    Arc::new(|_, _| {})
}

fn target(remote: &str, branch: &str, dir: SyncDirection) -> SyncTarget {
    SyncTarget {
        id: String::new(),
        remote: Some(remote.into()),
        url: None,
        remote_branch: branch.into(),
        direction: dir,
        force: false,
        enabled: true,
    }
}

#[test]
fn multi_target_sync_and_isolated_failure() {
    let r = runner();
    let tmp = tempfile::tempdir().unwrap();
    let work = tmp.path().join("app");
    init_repo(&r, &work);
    let origin = bare(&r, tmp.path(), "origin.git");
    let github = bare(&r, tmp.path(), "github.git");
    let repo = Repo::new(&r, &work);
    remote::add(&repo, &RemoteInput { name: "origin".into(), fetch_url: origin.to_str().unwrap().into(), push_urls: vec![] }).unwrap();
    remote::add(&repo, &RemoteInput { name: "github".into(), fetch_url: github.to_str().unwrap().into(), push_urls: vec![] }).unwrap();
    // 不可达的第三个目标，验证失败不影响其他目标
    remote::add(&repo, &RemoteInput { name: "broken".into(), fetch_url: tmp.path().join("nope.git").to_str().unwrap().into(), push_urls: vec![] }).unwrap();

    let db = Db::open_in_memory().unwrap();
    let rec = db.insert_repo(work.to_str().unwrap(), "app", None).unwrap();
    let mut rule = db
        .upsert_rule(&SyncRule {
            id: String::new(),
            repo_id: rec.id.clone(),
            branch_pattern: "main".into(),
            targets: vec![
                target("origin", "main", SyncDirection::Push),
                target("github", "main", SyncDirection::Push),
                target("broken", "main", SyncDirection::Push),
            ],
            primary_target_id: None,
            order: 0,
        })
        .unwrap();
    // 设置 primary → git upstream 同步更新
    rule.primary_target_id = Some(rule.targets[0].id.clone());
    let rule = db.upsert_rule(&rule).unwrap();
    let updated = sync_engine::apply_primary_upstream(&repo, &rule, &branch::list(&repo).unwrap()).unwrap();
    assert_eq!(updated, vec!["main"]);
    assert_eq!(git(&r, &work, &["config", "branch.main.merge"]).trim(), "refs/heads/main");
    assert_eq!(git(&r, &work, &["config", "branch.main.remote"]).trim(), "origin");

    fs::write(work.join("a.txt"), "1\n2\n3\n4\n").unwrap();
    commit_all(&r, &work, "four");

    let rules = db.list_rules(&rec.id).unwrap();
    let report = sync_engine::run(
        &repo,
        &branch::list(&repo).unwrap(),
        &rules,
        &SyncRunReq { branches: None, target_ids: None, items: None, pull_strategy: Default::default(), confirmed_force: vec![] },
        &CancelToken::new(),
        &noop_progress(),
    )
    .unwrap();
    let outcomes: Vec<(Option<String>, TargetOutcome)> = report.results.iter().map(|x| (x.remote.clone(), x.outcome)).collect();
    assert_eq!(outcomes.len(), 3);
    assert_eq!(outcomes[0], (Some("origin".into()), TargetOutcome::Success));
    assert_eq!(outcomes[1], (Some("github".into()), TargetOutcome::Success));
    assert!(matches!(outcomes[2].1, TargetOutcome::Failed | TargetOutcome::Network));

    // 两边提交一致
    let head = git(&r, &work, &["rev-parse", "HEAD"]);
    assert_eq!(git(&r, &origin, &["rev-parse", "main"]), head);
    assert_eq!(git(&r, &github, &["rev-parse", "main"]), head);

    // 再同步一次：已是最新
    let report = sync_engine::run(
        &repo,
        &branch::list(&repo).unwrap(),
        &rules,
        &SyncRunReq { branches: None, target_ids: Some(vec![rules[0].targets[1].id.clone()]), items: None, pull_strategy: Default::default(), confirmed_force: vec![] },
        &CancelToken::new(),
        &noop_progress(),
    )
    .unwrap();
    assert_eq!(report.results.len(), 1);
    assert_eq!(report.results[0].outcome, TargetOutcome::UpToDate);

    // 命令行改动 upstream → 映射显示不一致
    git(&r, &work, &["fetch", "-q", "github"]);
    git(&r, &work, &["branch", "--set-upstream-to=github/main", "main"]);
    let m = sync_engine::mapping(&repo, &branch::list(&repo).unwrap(), &rules).unwrap();
    let main = m.iter().find(|b| b.branch == "main").unwrap();
    assert_eq!(main.upstream_state, UpstreamState::Mismatch);
    assert!(main.targets.iter().find(|t| t.remote.as_deref() == Some("broken")).unwrap().remote_branch_exists == Some(false));

    // remote 被删除 → 目标标记 remote_missing
    remote::remove(&repo, "broken").unwrap();
    let m = sync_engine::mapping(&repo, &branch::list(&repo).unwrap(), &rules).unwrap();
    assert!(m[0].targets.iter().any(|t| t.remote_missing));
}

#[test]
fn wildcard_rule_with_branch_template_and_pull() {
    let r = runner();
    let tmp = tempfile::tempdir().unwrap();
    let work = tmp.path().join("app");
    init_repo(&r, &work);
    let origin = bare(&r, tmp.path(), "origin.git");
    let repo = Repo::new(&r, &work);
    git(&r, &work, &["remote", "add", "origin", origin.to_str().unwrap()]);
    git(&r, &work, &["push", "-q", "origin", "main"]);
    git(&r, &work, &["switch", "-q", "-c", "feature/login"]);
    fs::write(work.join("b.txt"), "b\n").unwrap();
    commit_all(&r, &work, "login");

    let rules = vec![SyncRule {
        id: "r1".into(),
        repo_id: "x".into(),
        branch_pattern: "feature/*".into(),
        targets: vec![SyncTarget { id: "t1".into(), ..target("origin", "${branch}", SyncDirection::Both) }],
        primary_target_id: Some("t1".into()),
        order: 10,
    }];
    let m = sync_engine::mapping(&repo, &branch::list(&repo).unwrap(), &rules).unwrap();
    let fl = m.iter().find(|b| b.branch == "feature/login").unwrap();
    assert_eq!(fl.targets[0].remote_branch, "feature/login");
    assert_eq!(fl.targets[0].remote_branch_exists, Some(false));
    assert_eq!(fl.targets[0].ahead, Some(1));
    assert!(m.iter().find(|b| b.branch == "main").unwrap().rule_id.is_none());

    let req = SyncRunReq { branches: Some(vec!["feature/login".into()]), target_ids: None, items: None, pull_strategy: Default::default(), confirmed_force: vec![] };

    // 精确 items：双向目标只执行 push，不应产生 pull 结果
    let push_only = SyncRunReq {
        branches: None,
        target_ids: None,
        items: Some(vec![gitmanagement_lib::sync_engine::SyncItem { branch: "feature/login".into(), target_id: "t1".into(), action: "push".into() }]),
        pull_strategy: Default::default(),
        confirmed_force: vec![],
    };
    // 远端分支尚不存在：只推送，push 新建远端分支
    let report = sync_engine::run(&repo, &branch::list(&repo).unwrap(), &rules, &push_only, &CancelToken::new(), &noop_progress()).unwrap();
    assert_eq!(report.results.len(), 1);
    assert_eq!(report.results[0].action, "push");
    assert_eq!(report.results[0].outcome, TargetOutcome::Success);
    assert!(git(&r, &origin, &["branch", "--list", "feature/login"]).contains("feature/login"));

    // 双向同步：pull 与 push 都已是最新
    let report = sync_engine::run(&repo, &branch::list(&repo).unwrap(), &rules, &req, &CancelToken::new(), &noop_progress()).unwrap();
    assert_eq!(report.results.len(), 2);
    assert!(report.results.iter().all(|x| x.outcome == TargetOutcome::UpToDate), "{:?}", report.results);

    // 另一个克隆往 feature/login 推一个提交，再按规则同步 → 当前分支快进合并
    let other = tmp.path().join("other");
    git(&r, tmp.path(), &["clone", "-q", "-b", "feature/login", origin.to_str().unwrap(), other.to_str().unwrap()]);
    configure(&r, &other);
    fs::write(other.join("c.txt"), "c\n").unwrap();
    commit_all(&r, &other, "remote c");
    git(&r, &other, &["push", "-q"]);

    let report = sync_engine::run(&repo, &branch::list(&repo).unwrap(), &rules, &req, &CancelToken::new(), &noop_progress()).unwrap();
    let pull = report.results.iter().find(|x| x.action == "pull").unwrap();
    assert_eq!(pull.outcome, TargetOutcome::Success, "{:?}", pull.error);
    assert!(work.join("c.txt").exists());
}

/// 构造冲突：main 与 topic 修改同一行 / 双方新增同名文件 / 我方删除对方修改
fn conflict_repo(r: &GitRunner, dir: &Path) {
    init_repo(r, dir);
    fs::write(dir.join("del.txt"), "keep\n").unwrap();
    commit_all(r, dir, "base");
    git(r, dir, &["switch", "-q", "-c", "topic"]);
    fs::write(dir.join("a.txt"), "1\nTHEIRS\n3\n").unwrap();
    fs::write(dir.join("new.txt"), "theirs new\n").unwrap();
    fs::write(dir.join("del.txt"), "keep but changed\n").unwrap();
    commit_all(r, dir, "topic");
    git(r, dir, &["switch", "-q", "main"]);
    fs::write(dir.join("a.txt"), "1\nOURS\n3\n").unwrap();
    fs::write(dir.join("new.txt"), "ours new\n").unwrap();
    fs::remove_file(dir.join("del.txt")).unwrap();
    commit_all(r, dir, "main");
}

#[test]
fn resolve_uu_aa_du_conflicts_and_continue_merge() {
    let r = runner();
    let tmp = tempfile::tempdir().unwrap();
    let work = tmp.path().join("中文 冲突");
    conflict_repo(&r, &work);
    let repo = Repo::new(&r, &work);

    let res = branch::integrate(&repo, "topic", IntegrateMode::Merge).unwrap();
    assert!(res.conflicts);
    let ctx = conflict::context(&repo).unwrap();
    assert_eq!(ctx.operation, Some(RepoOperation::Merge));
    assert_eq!(ctx.ours_label, "main");
    assert_eq!(ctx.theirs_label, "topic");
    let codes: Vec<(String, String)> = ctx.files.iter().map(|f| (f.path.clone(), f.code.clone())).collect();
    assert!(codes.contains(&("a.txt".into(), "UU".into())));
    assert!(codes.contains(&("new.txt".into(), "AA".into())));
    assert!(codes.contains(&("del.txt".into(), "DU".into())));

    // UU：三栏数据 → 一个冲突块，用户逐块选择后写回
    let data = conflict::load(&repo, "a.txt").unwrap();
    assert_eq!(data.blocks.iter().filter(|b| b.kind == BlockKind::Conflict).count(), 1);
    let base = split_lines(data.base.as_deref().unwrap());
    let ours = split_lines(data.ours.as_deref().unwrap());
    let theirs = split_lines(data.theirs.as_deref().unwrap());
    let (mut merged, n) = auto_merge(&base, &ours, &theirs, &data.blocks);
    assert_eq!(n, 1);
    merged[1] = "OURS+THEIRS".into();
    conflict::resolve(&repo, "a.txt", Some(&(merged.join("\n") + "\n"))).unwrap();

    // AA：整文件接受对方；DU：接受我方（我方已删除 → 删除文件）
    conflict::accept(&repo, &["new.txt".to_string()], Side::Theirs).unwrap();
    conflict::accept(&repo, &["del.txt".to_string()], Side::Ours).unwrap();
    assert!(conflict::list(&repo).unwrap().is_empty());
    assert!(!work.join("del.txt").exists());

    // 继续合并：提交面板不勾选文件也能完成合并提交
    let res = changes::commit(
        &repo,
        &CommitRequest {
            files: vec![],
            message: "Merge branch 'topic'".into(),
            amend: false,
            signoff: false,
            author: None,
            no_verify: false,
            staging_mode: false,
            partial: vec![],
        },
    )
    .unwrap();
    assert!(!res.hash.is_empty());
    let st = status(&repo, false).unwrap();
    assert!(st.operation.is_none());
    assert!(st.files.is_empty(), "{:?}", st.files);
    assert_eq!(fs::read_to_string(work.join("a.txt")).unwrap(), "1\nOURS+THEIRS\n3\n");
    assert_eq!(fs::read_to_string(work.join("new.txt")).unwrap(), "theirs new\n");
    let parents = git(&r, &work, &["rev-list", "--parents", "-n", "1", "HEAD"]);
    assert_eq!(parents.split_whitespace().count(), 3, "merge commit must have two parents");
}

#[test]
fn rebase_with_consecutive_conflicts() {
    let r = runner();
    let tmp = tempfile::tempdir().unwrap();
    let work = tmp.path().join("app");
    init_repo(&r, &work);
    git(&r, &work, &["switch", "-q", "-c", "topic"]);
    for (i, v) in ["T1", "T2", "T3"].iter().enumerate() {
        fs::write(work.join("a.txt"), format!("1\n{}\n3\n", v)).unwrap();
        commit_all(&r, &work, &format!("topic {}", i));
    }
    git(&r, &work, &["switch", "-q", "main"]);
    fs::write(work.join("a.txt"), "1\nM\n3\n").unwrap();
    commit_all(&r, &work, "main change");
    git(&r, &work, &["switch", "-q", "topic"]);
    let repo = Repo::new(&r, &work);

    let res = branch::integrate(&repo, "main", IntegrateMode::Rebase).unwrap();
    assert!(res.conflicts);
    let mut rounds = 0;
    loop {
        let st = status(&repo, false).unwrap();
        if st.operation.is_none() {
            break;
        }
        assert_eq!(st.operation, Some(RepoOperation::Rebase));
        rounds += 1;
        assert!(rounds <= 3, "too many rounds");
        let files = conflict::list(&repo).unwrap();
        assert_eq!(files.len(), 1);
        // 在三栏结果中合并双方：保留 main 的 M 并加上正在重放的 Tn，使下一个提交再次冲突
        let data = conflict::load(&repo, "a.txt").unwrap();
        assert_eq!(data.blocks.iter().filter(|b| b.kind == BlockKind::Conflict).count(), 1);
        let theirs_line = split_lines(data.theirs.as_deref().unwrap())[1].to_string();
        conflict::resolve(&repo, "a.txt", Some(&format!("1\nM+{}\n3\n", theirs_line))).unwrap();
        let r2 = branch::operation_action(&repo, OperationAction::Continue).unwrap();
        let _ = r2;
    }
    assert_eq!(rounds, 3, "each replayed commit should conflict");
    assert_eq!(fs::read_to_string(work.join("a.txt")).unwrap(), "1\nM+T3\n3\n");
    let n = git(&r, &work, &["rev-list", "--count", "main..topic"]);
    assert_eq!(n.trim(), "3");
    assert_eq!(branch::current(&repo).as_deref(), Some("topic"));
}

#[test]
fn log_detail_revert_reset_tag() {
    let r = runner();
    let tmp = tempfile::tempdir().unwrap();
    let work = tmp.path().join("app");
    init_repo(&r, &work);
    fs::write(work.join("b.txt"), "b\n").unwrap();
    commit_all(&r, &work, "add b");
    git(&r, &work, &["mv", "a.txt", "renamed a.txt"]);
    commit_all(&r, &work, "rename");
    let repo = Repo::new(&r, &work);

    let page = log::log(&repo, &LogQuery::default()).unwrap();
    assert_eq!(page.commits.len(), 3);
    assert!(!page.has_more);
    assert!(page.commits[0].refs.iter().any(|x| x.contains("main")));
    let page = log::log(&repo, &LogQuery { limit: Some(2), ..Default::default() }).unwrap();
    assert_eq!(page.commits.len(), 2);
    assert!(page.has_more);
    let page = log::log(&repo, &LogQuery { grep: Some("ADD".into()), ..Default::default() }).unwrap();
    assert_eq!(page.commits.len(), 1);

    let top = log::log(&repo, &LogQuery::default()).unwrap().commits;
    let d = log::detail(&repo, &top[0].hash).unwrap();
    assert_eq!(d.files.len(), 1);
    assert_eq!(d.files[0].status, "R");
    assert_eq!(d.files[0].path, "renamed a.txt");
    let root = log::detail(&repo, &top[2].hash).unwrap();
    assert!(root.parents.is_empty());
    assert_eq!(root.files[0].status, "A");

    // revert "add b"
    let res = log::revert(&repo, &top[1].hash).unwrap();
    assert!(!res.conflicts);
    assert!(!work.join("b.txt").exists());

    log::create_tag(&repo, "v1.0", &top[2].hash, Some("first")).unwrap();
    assert!(log::create_tag(&repo, "bad..name", &top[2].hash, None).is_err());

    log::reset(&repo, &top[2].hash, ResetMode::Hard).unwrap();
    assert_eq!(git(&r, &work, &["rev-parse", "HEAD"]).trim(), top[2].hash);
    assert!(work.join("a.txt").exists());
}

#[test]
fn cherry_pick_conflict_then_commit() {
    let r = runner();
    let tmp = tempfile::tempdir().unwrap();
    let work = tmp.path().join("app");
    init_repo(&r, &work);
    git(&r, &work, &["switch", "-q", "-c", "topic"]);
    fs::write(work.join("a.txt"), "1\nT\n3\n").unwrap();
    commit_all(&r, &work, "topic");
    let pick = git(&r, &work, &["rev-parse", "HEAD"]).trim().to_string();
    git(&r, &work, &["switch", "-q", "main"]);
    fs::write(work.join("a.txt"), "1\nM\n3\n").unwrap();
    commit_all(&r, &work, "main");
    let repo = Repo::new(&r, &work);

    let res = log::cherry_pick(&repo, &pick).unwrap();
    assert!(res.conflicts);
    conflict::accept(&repo, &["a.txt".to_string()], Side::Theirs).unwrap();
    changes::commit(
        &repo,
        &CommitRequest { files: vec![], message: "topic (picked)".into(), amend: false, signoff: false, author: None, no_verify: false, staging_mode: false, partial: vec![] },
    )
    .unwrap();
    let st = status(&repo, false).unwrap();
    assert!(st.operation.is_none(), "cherry-pick state should be cleared, got {:?}", st.operation);
}

#[test]
fn remote_crud_strips_credentials() {
    let r = runner();
    let tmp = tempfile::tempdir().unwrap();
    let work = tmp.path().join("app");
    init_repo(&r, &work);
    let repo = Repo::new(&r, &work);
    remote::add(&repo, &RemoteInput { name: "origin".into(), fetch_url: "git@example.com:a/b.git".into(), push_urls: vec!["git@m1:a/b.git".into(), "git@m2:a/b.git".into()] }).unwrap();
    assert!(remote::add(&repo, &RemoteInput { name: "origin".into(), fetch_url: "x".into(), push_urls: vec![] }).is_err());
    assert!(remote::add(&repo, &RemoteInput { name: "bad name".into(), fetch_url: "x".into(), push_urls: vec![] }).is_err());
    assert!(remote::add(&repo, &RemoteInput { name: "--upload-pack=x".into(), fetch_url: "x".into(), push_urls: vec![] }).is_err());
    let push = git(&r, &work, &["config", "--get-all", "remote.origin.pushurl"]);
    assert_eq!(push.lines().count(), 2);

    remote::update(&repo, "origin", &RemoteInput { name: "corp".into(), fetch_url: "git@example.com:a/c.git".into(), push_urls: vec![] }).unwrap();
    assert_eq!(git(&r, &work, &["remote"]).trim(), "corp");
    assert_eq!(git(&r, &work, &["config", "remote.corp.url"]).trim(), "git@example.com:a/c.git");
    assert!(r.exec(&work, &["config", "--get-all", "remote.corp.pushurl"], &RunOpts::read()).unwrap().code != 0);

    // ls-remote 测试：本地裸仓库可达，不存在的路径不可达
    let origin = bare(&r, tmp.path(), "o.git");
    remote::add(&repo, &RemoteInput { name: "local".into(), fetch_url: origin.to_str().unwrap().into(), push_urls: vec![] }).unwrap();
    assert!(remote::test(&repo, "local", &CancelToken::new()).unwrap().ok);
    remote::add(&repo, &RemoteInput { name: "gone".into(), fetch_url: tmp.path().join("x.git").to_str().unwrap().into(), push_urls: vec![] }).unwrap();
    assert!(!remote::test(&repo, "gone", &CancelToken::new()).unwrap().ok);
    remote::remove(&repo, "gone").unwrap();
}
