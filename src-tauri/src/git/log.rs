//! 历史日志（L-01 提交图数据、L-03 提交详情、L-04 提交操作）。

use super::branch::{conflict_or_ok, IntegrateResult};
use super::parse::{FS, RS};
use super::runner::RunOpts;
use super::{check_arg, Repo};
use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};

pub const PAGE_SIZE: u32 = 500;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LogCommit {
    pub hash: String,
    pub short_hash: String,
    pub parents: Vec<String>,
    pub author_name: String,
    pub author_email: String,
    pub author_time: i64,
    pub subject: String,
    /// 分支/标签标记：HEAD -> main, origin/main, tag: v1.0
    pub refs: Vec<String>,
}

const FORMAT: &str = "--format=%H%x1f%h%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%D%x1f%s%x1e";

pub fn parse_log_page(text: &str) -> Vec<LogCommit> {
    text.split(RS)
        .filter_map(|rec| {
            let rec = rec.trim_start_matches(|c: char| c == '\n' || c == '\r');
            let f: Vec<&str> = rec.split(FS).collect();
            if f.len() < 8 || f[0].is_empty() {
                return None;
            }
            Some(LogCommit {
                hash: f[0].into(),
                short_hash: f[1].into(),
                parents: f[2].split_whitespace().map(String::from).collect(),
                author_name: f[3].into(),
                author_email: f[4].into(),
                author_time: f[5].parse().unwrap_or(0),
                refs: f[6].split(", ").map(str::trim).filter(|s| !s.is_empty()).map(String::from).collect(),
                subject: f[7..].join("\u{1f}"),
            })
        })
        .collect()
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct LogQuery {
    /// 分支/引用；为空表示 --all
    pub refs: Vec<String>,
    pub skip: u32,
    pub limit: Option<u32>,
    /// 消息关键字（L-02）
    pub grep: Option<String>,
    /// 作者（名字或邮箱的一部分，不区分大小写）
    pub author: Option<String>,
    /// 起止日期 YYYY-MM-DD（含当天）
    pub since: Option<String>,
    pub until: Option<String>,
    /// 只显示修改了这些路径的提交
    pub paths: Vec<String>,
}

fn check_date(d: &str) -> AppResult<()> {
    let ok = d.len() == 10
        && d.chars().enumerate().all(|(i, c)| if i == 4 || i == 7 { c == '-' } else { c.is_ascii_digit() });
    if ok {
        Ok(())
    } else {
        Err(AppError::new("log.invalidDate").param("value", d))
    }
}

fn non_empty(s: &Option<String>) -> Option<&str> {
    s.as_deref().map(str::trim).filter(|s| !s.is_empty())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogPage {
    pub commits: Vec<LogCommit>,
    pub has_more: bool,
}

pub fn log(repo: &Repo, q: &LogQuery) -> AppResult<LogPage> {
    if repo.head_oid().is_none() && q.refs.is_empty() {
        // 空仓库
        let any = repo.read(&["for-each-ref", "--count=1", "refs"])?.trimmed();
        if any.is_empty() {
            return Ok(LogPage { commits: Vec::new(), has_more: false });
        }
    }
    let limit = q.limit.unwrap_or(PAGE_SIZE).clamp(1, 5000);
    let mut args: Vec<String> = vec![
        "log".into(),
        FORMAT.into(),
        "--topo-order".into(),
        format!("--skip={}", q.skip),
        format!("--max-count={}", limit + 1),
    ];
    let grep = non_empty(&q.grep);
    let author = non_empty(&q.author);
    if grep.is_some() || author.is_some() {
        // -i / --fixed-strings 同时作用于 --grep 与 --author
        args.push("-i".into());
        args.push("--fixed-strings".into());
    }
    if let Some(g) = grep {
        args.push(format!("--grep={}", g));
    }
    if let Some(a) = author {
        args.push(format!("--author={}", a));
    }
    if let Some(d) = non_empty(&q.since) {
        check_date(d)?;
        args.push(format!("--since={}T00:00:00", d));
    }
    if let Some(d) = non_empty(&q.until) {
        check_date(d)?;
        args.push(format!("--until={}T23:59:59", d));
    }
    if q.refs.is_empty() {
        args.push("--all".into());
    } else {
        for r in &q.refs {
            check_arg("rev", r)?;
            args.push(r.clone());
        }
    }
    args.push("--".into());
    for p in q.paths.iter().map(|p| p.trim()).filter(|p| !p.is_empty()) {
        args.push(p.to_string());
    }
    let out = repo.read(&args)?;
    let mut commits = parse_log_page(&out.text());
    let has_more = commits.len() as u32 > limit;
    commits.truncate(limit as usize);
    Ok(LogPage { commits, has_more })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitFile {
    /// A / M / D / R / C / T
    pub status: String,
    pub path: String,
    pub old_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetail {
    pub hash: String,
    pub parents: Vec<String>,
    pub author_name: String,
    pub author_email: String,
    pub author_time: i64,
    pub committer_name: String,
    pub committer_email: String,
    pub committer_time: i64,
    pub message: String,
    /// 与第一个父提交（无父提交时与空树）的差异文件
    pub files: Vec<CommitFile>,
}

/// 解析 `diff-tree --name-status -z -M`
pub fn parse_name_status_z(raw: &[u8]) -> Vec<CommitFile> {
    let text = String::from_utf8_lossy(raw);
    let tokens: Vec<&str> = text.split('\0').collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < tokens.len() {
        let st = tokens[i];
        i += 1;
        if st.is_empty() {
            continue;
        }
        let code = &st[..1];
        if code == "R" || code == "C" {
            let old = tokens.get(i).copied().unwrap_or("");
            let new = tokens.get(i + 1).copied().unwrap_or("");
            i += 2;
            out.push(CommitFile { status: code.into(), path: new.into(), old_path: Some(old.into()) });
        } else {
            let p = tokens.get(i).copied().unwrap_or("");
            i += 1;
            out.push(CommitFile { status: code.into(), path: p.into(), old_path: None });
        }
    }
    out
}

pub fn detail(repo: &Repo, hash: &str) -> AppResult<CommitDetail> {
    check_arg("rev", hash)?;
    let out = repo.read(&["show", "-s", "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%ce%x1f%ct%x1f%B", hash])?;
    let text = out.text();
    let f: Vec<&str> = text.splitn(9, FS).collect();
    if f.len() < 9 {
        return Err(AppError::new("log.commitNotFound").param("hash", hash));
    }
    let parents: Vec<String> = f[1].split_whitespace().map(String::from).collect();
    let base = parents.first().cloned().unwrap_or_else(|| super::EMPTY_TREE.to_string());
    let files_out = repo.read(&["diff-tree", "-r", "-z", "-M", "--name-status", "--no-commit-id", base.as_str(), f[0]])?;
    Ok(CommitDetail {
        hash: f[0].into(),
        parents,
        author_name: f[2].into(),
        author_email: f[3].into(),
        author_time: f[4].parse().unwrap_or(0),
        committer_name: f[5].into(),
        committer_email: f[6].into(),
        committer_time: f[7].parse().unwrap_or(0),
        message: f[8].trim_end().into(),
        files: parse_name_status_z(&files_out.stdout),
    })
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ResetMode {
    Soft,
    Mixed,
    Hard,
}

/// Reset 当前分支到某提交（L-04）。hard 需要前端二次确认。
pub fn reset(repo: &Repo, hash: &str, mode: ResetMode) -> AppResult<()> {
    check_arg("rev", hash)?;
    let flag = match mode {
        ResetMode::Soft => "--soft",
        ResetMode::Mixed => "--mixed",
        ResetMode::Hard => "--hard",
    };
    repo.write(&["reset", "-q", flag, hash])?;
    Ok(())
}

/// Revert（L-04）。合并提交使用第一个父提交作为主线。
pub fn revert(repo: &Repo, hash: &str) -> AppResult<IntegrateResult> {
    check_arg("rev", hash)?;
    let d = detail(repo, hash)?;
    let out = if d.parents.len() > 1 {
        repo.exec(&["revert", "--no-edit", "-m", "1", hash], &RunOpts::literal())?
    } else {
        repo.exec(&["revert", "--no-edit", hash], &RunOpts::literal())?
    };
    conflict_or_ok(repo, out)
}

/// Cherry-pick（L-04）
pub fn cherry_pick(repo: &Repo, hash: &str) -> AppResult<IntegrateResult> {
    check_arg("rev", hash)?;
    let out = repo.exec(&["cherry-pick", hash], &RunOpts::literal())?;
    conflict_or_ok(repo, out)
}

pub fn create_tag(repo: &Repo, name: &str, hash: &str, message: Option<&str>) -> AppResult<()> {
    check_arg("tag", name)?;
    check_arg("rev", hash)?;
    let probe = format!("refs/tags/{}", name);
    if repo.exec(&["check-ref-format", probe.as_str()], &RunOpts::read())?.code != 0 {
        return Err(AppError::new("log.invalidTagName").param("name", name));
    }
    match message.map(str::trim).filter(|m| !m.is_empty()) {
        Some(m) => repo.write(&["tag", "-a", name, "-m", m, hash])?,
        None => repo.write(&["tag", name, hash])?,
    };
    Ok(())
}

// ======================= M3：文件历史与 Blame（L-05） =======================

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileHistoryEntry {
    pub commit: LogCommit,
    /// A / M / D / R …
    pub status: String,
    /// 该提交中文件的路径（跟踪重命名）
    pub path: String,
    pub old_path: Option<String>,
}

const FH_FORMAT: &str = "--format=%x1e%H%x1f%h%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%D%x1f%s";

/// 解析 `log --follow --name-status -z` 输出：
/// `\x1e<header>\0\n<status>\0<path>\0[<path2>\0]`
pub fn parse_file_history(raw: &[u8]) -> Vec<FileHistoryEntry> {
    let text = String::from_utf8_lossy(raw);
    let mut out: Vec<FileHistoryEntry> = Vec::new();
    for rec in text.split(RS).filter(|r| !r.is_empty()) {
        let mut tokens = rec.split('\0').map(|t| t.trim_matches(|c| c == '\n' || c == '\r'));
        let Some(header) = tokens.next() else { continue };
        let Some(commit) = parse_log_page(&format!("{}{}", header, RS)).into_iter().next() else { continue };
        let rest: Vec<&str> = tokens.filter(|t| !t.is_empty()).collect();
        let (status, path, old_path) = match rest.first() {
            Some(st) if st.starts_with('R') || st.starts_with('C') => (
                st[..1].to_string(),
                rest.get(2).copied().unwrap_or("").to_string(),
                rest.get(1).map(|s| s.to_string()),
            ),
            Some(st) => (st[..1].to_string(), rest.get(1).copied().unwrap_or("").to_string(), None),
            // 合并提交默认不列出文件：路径沿用较新的条目（之后再用较旧的条目补齐）
            None => ("M".into(), out.last().map(|e| e.path.clone()).unwrap_or_default(), None),
        };
        out.push(FileHistoryEntry { commit, status, path, old_path });
    }
    for i in (0..out.len()).rev() {
        if out[i].path.is_empty() {
            if let Some(next) = out.get(i + 1).map(|e| e.old_path.clone().unwrap_or_else(|| e.path.clone())) {
                out[i].path = next;
            }
        }
    }
    out
}

pub fn file_history(repo: &Repo, path: &str, skip: u32, limit: Option<u32>) -> AppResult<(Vec<FileHistoryEntry>, bool)> {
    repo.join(path)?;
    if repo.head_oid().is_none() {
        return Ok((Vec::new(), false));
    }
    let limit = limit.unwrap_or(PAGE_SIZE).clamp(1, 5000);
    let skip_arg = format!("--skip={}", skip);
    let max_arg = format!("--max-count={}", limit + 1);
    let out = repo.read(&[
        "log",
        FH_FORMAT,
        "--follow",
        "-M",
        "--name-status",
        "-z",
        skip_arg.as_str(),
        max_arg.as_str(),
        "HEAD",
        "--",
        path,
    ])?;
    let mut entries = parse_file_history(&out.stdout);
    for e in entries.iter_mut().filter(|e| e.path.is_empty()) {
        e.path = path.to_string();
    }
    let more = entries.len() as u32 > limit;
    entries.truncate(limit as usize);
    Ok((entries, more))
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BlameCommit {
    pub hash: String,
    pub author_name: String,
    pub author_email: String,
    pub author_time: i64,
    pub summary: String,
    /// 尚未提交的修改（全 0 哈希）
    pub uncommitted: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BlameLine {
    pub hash: String,
    pub orig_line: u32,
    pub content: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlameResult {
    pub commits: Vec<BlameCommit>,
    pub lines: Vec<BlameLine>,
}

/// 解析 `git blame --porcelain`
pub fn parse_blame(text: &str) -> BlameResult {
    let mut commits: Vec<BlameCommit> = Vec::new();
    let mut lines = Vec::new();
    let mut cur_hash = String::new();
    let mut cur_orig = 0u32;
    let mut it = text.split('\n');
    while let Some(line) = it.next() {
        if let Some(content) = line.strip_prefix('\t') {
            lines.push(BlameLine { hash: cur_hash.clone(), orig_line: cur_orig, content: content.trim_end_matches('\r').to_string() });
            continue;
        }
        let mut parts = line.split(' ');
        let first = parts.next().unwrap_or("");
        if first.len() == 40 && first.chars().all(|c| c.is_ascii_hexdigit()) {
            cur_hash = first.to_string();
            cur_orig = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
            if !commits.iter().any(|c| c.hash == cur_hash) {
                commits.push(BlameCommit {
                    hash: cur_hash.clone(),
                    author_name: String::new(),
                    author_email: String::new(),
                    author_time: 0,
                    summary: String::new(),
                    uncommitted: cur_hash.chars().all(|c| c == '0'),
                });
            }
            continue;
        }
        let Some(c) = commits.iter_mut().find(|c| c.hash == cur_hash) else { continue };
        let value = line.split_once(' ').map(|(_, v)| v).unwrap_or("");
        match first {
            "author" => c.author_name = value.to_string(),
            "author-mail" => c.author_email = value.trim_matches(|ch| ch == '<' || ch == '>').to_string(),
            "author-time" => c.author_time = value.parse().unwrap_or(0),
            "summary" => c.summary = value.to_string(),
            _ => {}
        }
    }
    BlameResult { commits, lines }
}

/// Blame（L-05）。rev 为 None 时针对工作区当前内容（含未提交修改）
pub fn blame(repo: &Repo, path: &str, rev: Option<&str>) -> AppResult<BlameResult> {
    repo.join(path)?;
    let mut args: Vec<String> = vec!["blame".into(), "--porcelain".into(), "-w".into()];
    if let Some(r) = rev {
        check_arg("rev", r)?;
        args.push(r.to_string());
    }
    args.push("--".into());
    args.push(path.to_string());
    let out = repo.read(&args)?;
    Ok(parse_blame(&out.text()))
}

// ======================= M3：比较（B-06、D-06） =======================

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefCompare {
    /// 仅在 b 中的提交（a..b）
    pub only_right: Vec<LogCommit>,
    /// 仅在 a 中的提交（b..a）
    pub only_left: Vec<LogCommit>,
    pub truncated: bool,
    /// 两者树之间的文件差异（a → b）
    pub files: Vec<CommitFile>,
}

const COMPARE_LIMIT: u32 = 500;

fn range_commits(repo: &Repo, range: &str) -> AppResult<(Vec<LogCommit>, bool)> {
    let max = format!("--max-count={}", COMPARE_LIMIT + 1);
    let out = repo.read(&["log", FORMAT, "--topo-order", max.as_str(), range, "--"])?;
    let mut c = parse_log_page(&out.text());
    let more = c.len() as u32 > COMPARE_LIMIT;
    c.truncate(COMPARE_LIMIT as usize);
    Ok((c, more))
}

/// 比较两个分支/提交（B-06）
pub fn compare_refs(repo: &Repo, left: &str, right: &str) -> AppResult<RefCompare> {
    check_arg("rev", left)?;
    check_arg("rev", right)?;
    let (only_right, t1) = range_commits(repo, &format!("{}..{}", left, right))?;
    let (only_left, t2) = range_commits(repo, &format!("{}..{}", right, left))?;
    Ok(RefCompare { only_right, only_left, truncated: t1 || t2, files: compare_files(repo, left, Some(right))? })
}

/// 任意两个版本之间的文件列表（D-06）。right 为 None 表示工作区（仅已跟踪文件）
pub fn compare_files(repo: &Repo, left: &str, right: Option<&str>) -> AppResult<Vec<CommitFile>> {
    check_arg("rev", left)?;
    let mut args: Vec<&str> = vec!["diff", "--name-status", "-z", "-M", "--no-ext-diff", left];
    if let Some(r) = right {
        check_arg("rev", r)?;
        args.push(r);
    }
    args.push("--");
    let out = repo.read(&args)?;
    Ok(parse_name_status_z(&out.stdout))
}

// ======================= M3：标签管理（B-08） =======================

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TagInfo {
    pub name: String,
    /// 指向的提交
    pub commit: String,
    pub annotated: bool,
    pub time: i64,
    pub subject: String,
}

pub fn parse_tags(text: &str) -> Vec<TagInfo> {
    text.lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.split(FS).collect();
            if f.len() < 6 || f[0].is_empty() {
                return None;
            }
            let annotated = f[1] == "tag";
            Some(TagInfo {
                name: f[0].to_string(),
                commit: if annotated && !f[2].is_empty() { f[2].to_string() } else { f[3].to_string() },
                annotated,
                time: f[4].parse().unwrap_or(0),
                subject: f[5..].join("\u{1f}"),
            })
        })
        .collect()
}

pub fn list_tags(repo: &Repo) -> AppResult<Vec<TagInfo>> {
    let out = repo.read(&[
        "for-each-ref",
        "--sort=-creatordate",
        "--format=%(refname:strip=2)%1f%(objecttype)%1f%(*objectname)%1f%(objectname)%1f%(creatordate:unix)%1f%(contents:subject)",
        "refs/tags",
    ])?;
    Ok(parse_tags(&out.text()))
}

pub fn delete_tag(repo: &Repo, name: &str) -> AppResult<()> {
    check_arg("tag", name)?;
    repo.write(&["tag", "-d", name])?;
    Ok(())
}

/// 推送标签；name 为 None 时推送全部标签
pub fn push_tag(repo: &Repo, remote: &str, name: Option<&str>, cancel: &super::runner::CancelToken) -> AppResult<String> {
    check_arg("remote", remote)?;
    let opts = RunOpts { cancel: Some(cancel.clone()), redact_stdout: true, ..Default::default() };
    let out = match name {
        Some(n) => {
            check_arg("tag", n)?;
            let spec = format!("refs/tags/{0}:refs/tags/{0}", n);
            repo.run_with(&["push", "--porcelain", remote, spec.as_str()], &opts)?
        }
        None => repo.run_with(&["push", "--porcelain", "--tags", remote], &opts)?,
    };
    Ok(format!("{}{}", out.text(), out.stderr))
}

pub fn delete_remote_tag(repo: &Repo, remote: &str, name: &str, cancel: &super::runner::CancelToken) -> AppResult<()> {
    check_arg("remote", remote)?;
    check_arg("tag", name)?;
    let spec = format!(":refs/tags/{}", name);
    repo.run_with(&["push", "--porcelain", remote, spec.as_str()], &RunOpts { cancel: Some(cancel.clone()), ..Default::default() })?;
    Ok(())
}

// ======================= M3：二进制 / 图片内容（D-05） =======================

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlobData {
    pub exists: bool,
    pub size: u64,
    /// git blob 哈希
    pub oid: Option<String>,
    /// 不超过上限时返回 base64 内容
    pub base64: Option<String>,
}

pub const BLOB_LIMIT: usize = 20 * 1024 * 1024;

/// rev：None = 工作区；Some("") 或 Some(":") = 暂存区；其他 = 提交/分支
pub fn blob_data(repo: &Repo, rev: Option<&str>, path: &str) -> AppResult<BlobData> {
    let bytes = match rev {
        None => {
            let p = repo.join(path)?;
            if p.is_file() {
                Some(std::fs::read(p)?)
            } else {
                None
            }
        }
        Some(r) => {
            repo.join(path)?;
            let spec = if r.is_empty() || r == ":" {
                format!(":{}", path)
            } else {
                check_arg("rev", r)?;
                format!("{}:{}", r, path)
            };
            let out = repo.exec(&["cat-file", "blob", spec.as_str()], &RunOpts::read())?;
            if out.code == 0 {
                Some(out.stdout)
            } else {
                None
            }
        }
    };
    let Some(b) = bytes else {
        return Ok(BlobData { exists: false, size: 0, oid: None, base64: None });
    };
    let oid = repo
        .run_with(&["hash-object", "--stdin"], &RunOpts { stdin: Some(b.clone()), read_only: true, ..Default::default() })
        .ok()
        .map(|o| o.trimmed());
    Ok(BlobData {
        exists: true,
        size: b.len() as u64,
        oid,
        base64: if b.len() <= BLOB_LIMIT { Some(base64_encode(&b)) } else { None },
    })
}

pub fn base64_encode(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = (b[0] as u32) << 16 | (b[1] as u32) << 8 | b[2] as u32;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn b64() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn parses_tags() {
        let t = "v1.0\u{1f}tag\u{1f}c1\u{1f}t1\u{1f}100\u{1f}Release 1\nlight\u{1f}commit\u{1f}\u{1f}c2\u{1f}99\u{1f}msg\n";
        let tags = parse_tags(t);
        assert_eq!(tags.len(), 2);
        assert!(tags[0].annotated);
        assert_eq!(tags[0].commit, "c1");
        assert_eq!(tags[1].commit, "c2");
    }

    #[test]
    fn parses_history() {
        let raw = "\u{1e}h3\u{1f}s3\u{1f}h2\u{1f}A\u{1f}a@x\u{1f}3\u{1f}\u{1f}three\0\nM\0g h.txt\0\u{1e}h2\u{1f}s2\u{1f}h1\u{1f}A\u{1f}a@x\u{1f}2\u{1f}\u{1f}two\0\nR100\0f.txt\0g h.txt\0\u{1e}h1\u{1f}s1\u{1f}\u{1f}A\u{1f}a@x\u{1f}1\u{1f}\u{1f}one\0\nA\0f.txt\0";
        let h = parse_file_history(raw.as_bytes());
        assert_eq!(h.len(), 3);
        assert_eq!(h[0].path, "g h.txt");
        assert_eq!(h[1].status, "R");
        assert_eq!(h[1].old_path.as_deref(), Some("f.txt"));
        assert_eq!(h[2].path, "f.txt");
        assert_eq!(h[2].commit.subject, "one");
    }

    #[test]
    fn parses_blame() {
        let h1 = "a".repeat(40);
        let h0 = "0".repeat(40);
        let t = format!(
            "{h1} 1 1 2\nauthor Me\nauthor-mail <me@x>\nauthor-time 100\nsummary init\nfilename f\n\tline1\n{h1} 2 2\n\tline2\n{h0} 3 3 1\nauthor Not Committed Yet\nauthor-time 200\nsummary Version of f from f\nfilename f\n\tnew\n"
        );
        let b = parse_blame(&t);
        assert_eq!(b.lines.len(), 3);
        assert_eq!(b.commits.len(), 2);
        assert_eq!(b.commits[0].author_email, "me@x");
        assert!(b.commits[1].uncommitted);
        assert_eq!(b.lines[1].content, "line2");
        assert_eq!(b.lines[1].orig_line, 2);
    }

    #[test]
    fn dates() {
        assert!(check_date("2026-10-28").is_ok());
        assert!(check_date("2026-1-28").is_err());
        assert!(check_date("--all").is_err());
    }

    #[test]
    fn parses_page() {
        let t = "h1\u{1f}s1\u{1f}p1 p2\u{1f}Me\u{1f}me@x\u{1f}100\u{1f}HEAD -> main, origin/main, tag: v1\u{1f}Merge x\u{1e}\nh2\u{1f}s2\u{1f}\u{1f}Me\u{1f}me@x\u{1f}99\u{1f}\u{1f}init\u{1e}\n";
        let c = parse_log_page(t);
        assert_eq!(c.len(), 2);
        assert_eq!(c[0].parents, vec!["p1", "p2"]);
        assert_eq!(c[0].refs, vec!["HEAD -> main", "origin/main", "tag: v1"]);
        assert!(c[1].parents.is_empty());
        assert!(c[1].refs.is_empty());
    }

    #[test]
    fn parses_name_status() {
        let raw = b"M\0src/a.ts\0R100\0old.md\0new.md\0A\0\xe4\xb8\xad \xe6\x96\x87.txt\0";
        let f = parse_name_status_z(raw);
        assert_eq!(f.len(), 3);
        assert_eq!(f[1].status, "R");
        assert_eq!(f[1].old_path.as_deref(), Some("old.md"));
        assert_eq!(f[2].path, "中 文.txt");
    }
}
