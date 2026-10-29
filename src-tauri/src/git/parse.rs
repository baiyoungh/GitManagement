//! git 机器可读输出解析（specs/07 第 1.1 节）。全部为纯函数，便于用固定样本做单元测试。

use serde::Serialize;
use std::collections::HashMap;

/// 字段分隔符 0x1f / 记录分隔符 0x1e，与 `--format` 中的 `%x1f` / `%x1e`（for-each-ref 用 `%1f`）对应
pub const FS: char = '\u{1f}';
pub const RS: char = '\u{1e}';

pub fn parse_version(s: &str) -> Option<(u32, u32, u32)> {
    // "git version 2.39.3 (Apple Git-145)" / "git version 2.45.1.windows.1"
    let rest = s.trim().strip_prefix("git version ")?;
    let ver = rest.split_whitespace().next()?;
    let mut it = ver.split('.').map(|p| {
        p.chars()
            .take_while(|c| c.is_ascii_digit())
            .collect::<String>()
            .parse::<u32>()
            .unwrap_or(0)
    });
    Some((it.next()?, it.next().unwrap_or(0), it.next().unwrap_or(0)))
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ChangeKind {
    Modified,
    Added,
    Deleted,
    Renamed,
    Copied,
    TypeChanged,
    Untracked,
    Conflicted,
    Ignored,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    pub orig_path: Option<String>,
    pub kind: ChangeKind,
    /// porcelain v2 的 X（暂存区相对 HEAD），未变化为 '.'
    pub index_status: String,
    /// porcelain v2 的 Y（工作区相对暂存区），未变化为 '.'
    pub worktree_status: String,
    pub staged: bool,
    pub unstaged: bool,
    /// 冲突类型：UU / AA / DU / UD / AU / UA / DD
    pub conflict: Option<String>,
    pub submodule: bool,
    pub added: Option<u32>,
    pub removed: Option<u32>,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BranchStatus {
    /// None 表示尚无提交（unborn）
    pub oid: Option<String>,
    /// None 表示分离 HEAD
    pub head: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct StatusParse {
    pub branch: BranchStatus,
    pub files: Vec<FileChange>,
}

/// 解析 `git status --porcelain=v2 -z --branch`
pub fn parse_status_v2(raw: &[u8]) -> StatusParse {
    let text = String::from_utf8_lossy(raw);
    let tokens: Vec<&str> = text.split('\0').collect();
    let mut out = StatusParse::default();
    let mut i = 0;
    while i < tokens.len() {
        let line = tokens[i];
        i += 1;
        if line.is_empty() {
            continue;
        }
        if let Some(h) = line.strip_prefix("# ") {
            parse_branch_header(h, &mut out.branch);
            continue;
        }
        let kind_char = line.as_bytes()[0];
        match kind_char {
            b'1' => {
                let f: Vec<&str> = line.splitn(9, ' ').collect();
                if f.len() == 9 {
                    out.files.push(ordinary(f[1], f[2], f[8], None, false));
                }
            }
            b'2' => {
                let f: Vec<&str> = line.splitn(10, ' ').collect();
                let orig = tokens.get(i).map(|s| s.to_string());
                i += 1;
                if f.len() == 10 {
                    out.files.push(ordinary(f[1], f[2], f[9], orig, true));
                }
            }
            b'u' => {
                let f: Vec<&str> = line.splitn(11, ' ').collect();
                if f.len() == 11 {
                    let (x, y) = split_xy(f[1]);
                    out.files.push(FileChange {
                        path: f[10].to_string(),
                        orig_path: None,
                        kind: ChangeKind::Conflicted,
                        index_status: x.to_string(),
                        worktree_status: y.to_string(),
                        staged: false,
                        unstaged: true,
                        conflict: Some(f[1].to_string()),
                        submodule: f[2].starts_with('S'),
                        added: None,
                        removed: None,
                    });
                }
            }
            b'?' | b'!' if line.len() > 2 => {
                let untracked = kind_char == b'?';
                out.files.push(FileChange {
                    path: line[2..].to_string(),
                    orig_path: None,
                    kind: if untracked { ChangeKind::Untracked } else { ChangeKind::Ignored },
                    index_status: (if untracked { "?" } else { "!" }).to_string(),
                    worktree_status: (if untracked { "?" } else { "!" }).to_string(),
                    staged: false,
                    unstaged: true,
                    conflict: None,
                    submodule: false,
                    added: None,
                    removed: None,
                });
            }
            _ => {}
        }
    }
    out
}

fn split_xy(xy: &str) -> (char, char) {
    let mut c = xy.chars();
    (c.next().unwrap_or('.'), c.next().unwrap_or('.'))
}

fn ordinary(xy: &str, sub: &str, path: &str, orig: Option<String>, renamed_entry: bool) -> FileChange {
    let (x, y) = split_xy(xy);
    let kind = if renamed_entry {
        if x == 'C' || y == 'C' {
            ChangeKind::Copied
        } else {
            ChangeKind::Renamed
        }
    } else if x == 'A' || y == 'A' {
        // y == 'A'：intent-to-add（git add -N）条目
        ChangeKind::Added
    } else if x == 'D' || y == 'D' {
        ChangeKind::Deleted
    } else if x == 'T' || y == 'T' {
        ChangeKind::TypeChanged
    } else {
        ChangeKind::Modified
    };
    FileChange {
        path: path.to_string(),
        orig_path: orig,
        kind,
        index_status: x.to_string(),
        worktree_status: y.to_string(),
        staged: x != '.',
        unstaged: y != '.',
        conflict: None,
        submodule: sub.starts_with('S'),
        added: None,
        removed: None,
    }
}

fn parse_branch_header(h: &str, b: &mut BranchStatus) {
    if let Some(v) = h.strip_prefix("branch.oid ") {
        b.oid = if v == "(initial)" { None } else { Some(v.to_string()) };
    } else if let Some(v) = h.strip_prefix("branch.head ") {
        b.head = if v == "(detached)" { None } else { Some(v.to_string()) };
    } else if let Some(v) = h.strip_prefix("branch.upstream ") {
        b.upstream = Some(v.to_string());
    } else if let Some(v) = h.strip_prefix("branch.ab ") {
        for part in v.split_whitespace() {
            if let Some(n) = part.strip_prefix('+') {
                b.ahead = n.parse().unwrap_or(0);
            } else if let Some(n) = part.strip_prefix('-') {
                b.behind = n.parse().unwrap_or(0);
            }
        }
    }
}

/// 解析 `git diff --numstat -z`，返回 新路径 → (增, 删)；二进制文件为 None
pub fn parse_numstat_z(raw: &[u8]) -> HashMap<String, (Option<u32>, Option<u32>)> {
    let text = String::from_utf8_lossy(raw);
    let tokens: Vec<&str> = text.split('\0').collect();
    let mut out = HashMap::new();
    let mut i = 0;
    while i < tokens.len() {
        let rec = tokens[i];
        i += 1;
        if rec.is_empty() {
            continue;
        }
        let mut parts = rec.splitn(3, '\t');
        let a = parts.next().unwrap_or("");
        let d = parts.next().unwrap_or("");
        let path = parts.next().unwrap_or("");
        let added = a.parse::<u32>().ok();
        let removed = d.parse::<u32>().ok();
        if path.is_empty() {
            // 重命名：added\tdeleted\t\0old\0new\0
            let new_path = tokens.get(i + 1).copied().unwrap_or("");
            i += 2;
            if !new_path.is_empty() {
                out.insert(new_path.to_string(), (added, removed));
            }
        } else {
            out.insert(path.to_string(), (added, removed));
        }
    }
    out
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum BranchKind {
    Local,
    Remote,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
    /// 本地：main；远端：origin/main
    pub name: String,
    pub full_ref: String,
    pub kind: BranchKind,
    /// 远端分支所属 remote
    pub remote: Option<String>,
    /// 远端分支在远端上的名字（去掉 remote 前缀）
    pub remote_branch: Option<String>,
    pub oid: String,
    pub is_head: bool,
    /// 本地分支的 upstream，例如 origin/main
    pub upstream: Option<String>,
    pub upstream_remote: Option<String>,
    pub upstream_branch: Option<String>,
    pub upstream_gone: bool,
    pub ahead: u32,
    pub behind: u32,
    pub committer_time: i64,
    pub subject: String,
}

pub const BRANCH_FORMAT: &str = "%(refname)%1f%(objectname)%1f%(HEAD)%1f%(upstream:short)%1f%(upstream:remotename)%1f%(upstream:remoteref)%1f%(upstream:track,nobracket)%1f%(committerdate:unix)%1f%(contents:subject)";

/// 解析 `git for-each-ref --format=BRANCH_FORMAT refs/heads refs/remotes`
pub fn parse_branches(text: &str, remotes: &[String]) -> Vec<BranchInfo> {
    let mut out = Vec::new();
    for line in text.lines() {
        let f: Vec<&str> = line.split(FS).collect();
        if f.len() < 9 {
            continue;
        }
        let full_ref = f[0].to_string();
        let (kind, name, remote, remote_branch) = if let Some(n) = full_ref.strip_prefix("refs/heads/") {
            (BranchKind::Local, n.to_string(), None, None)
        } else if let Some(n) = full_ref.strip_prefix("refs/remotes/") {
            let (r, b) = split_remote_ref(n, remotes);
            if b == "HEAD" || b.is_empty() {
                continue; // refs/remotes/origin/HEAD 是符号引用，不单独展示
            }
            (BranchKind::Remote, n.to_string(), Some(r), Some(b))
        } else {
            continue;
        };
        let (ahead, behind, gone) = parse_track(f[6]);
        let non_empty = |s: &str| if s.is_empty() { None } else { Some(s.to_string()) };
        out.push(BranchInfo {
            name,
            full_ref,
            kind,
            remote,
            remote_branch,
            oid: f[1].to_string(),
            is_head: f[2] == "*",
            upstream: non_empty(f[3]),
            upstream_remote: non_empty(f[4]),
            upstream_branch: non_empty(f[5].strip_prefix("refs/heads/").unwrap_or(f[5])),
            upstream_gone: gone,
            ahead,
            behind,
            committer_time: f[7].parse().unwrap_or(0),
            subject: f[8..].join("\u{1f}"),
        });
    }
    out
}

/// "origin/feature/x" → ("origin", "feature/x")；remote 名本身可能含 '/'，取最长匹配
pub fn split_remote_ref(name: &str, remotes: &[String]) -> (String, String) {
    let mut best: Option<&String> = None;
    for r in remotes {
        if name.len() > r.len() && name.starts_with(r.as_str()) && name.as_bytes()[r.len()] == b'/' {
            if best.map(|b| r.len() > b.len()).unwrap_or(true) {
                best = Some(r);
            }
        }
    }
    match best {
        Some(r) => (r.clone(), name[r.len() + 1..].to_string()),
        None => match name.find('/') {
            Some(i) => (name[..i].to_string(), name[i + 1..].to_string()),
            None => (name.to_string(), String::new()),
        },
    }
}

/// "ahead 2, behind 1" / "gone" / ""
pub fn parse_track(s: &str) -> (u32, u32, bool) {
    if s.trim() == "gone" {
        return (0, 0, true);
    }
    let mut ahead = 0;
    let mut behind = 0;
    for part in s.split(',') {
        let p = part.trim();
        if let Some(n) = p.strip_prefix("ahead ") {
            ahead = n.trim().parse().unwrap_or(0);
        } else if let Some(n) = p.strip_prefix("behind ") {
            behind = n.trim().parse().unwrap_or(0);
        }
    }
    (ahead, behind, false)
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CommitSummary {
    pub hash: String,
    pub short_hash: String,
    pub author_name: String,
    pub author_email: String,
    pub author_time: i64,
    pub subject: String,
}

pub const LOG_FORMAT: &str = "--format=%H%x1f%h%x1f%an%x1f%ae%x1f%at%x1f%s%x1e";

pub fn parse_log(text: &str) -> Vec<CommitSummary> {
    text.split(RS)
        .filter_map(|rec| {
            let rec = rec.trim_start_matches(|c: char| c == '\n' || c == '\r');
            let f: Vec<&str> = rec.split(FS).collect();
            if f.len() < 6 || f[0].is_empty() {
                return None;
            }
            Some(CommitSummary {
                hash: f[0].to_string(),
                short_hash: f[1].to_string(),
                author_name: f[2].to_string(),
                author_email: f[3].to_string(),
                author_time: f[4].parse().unwrap_or(0),
                subject: f[5..].join("\u{1f}"),
            })
        })
        .collect()
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Hunk {
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct UnifiedDiffMeta {
    pub hunks: Vec<Hunk>,
    pub binary: bool,
    pub old_mode: Option<String>,
    pub new_mode: Option<String>,
}

/// 解析 `git diff -U0` 输出中的 hunk 头和元信息（内容由调用方另行读取完整文本）
pub fn parse_unified(text: &str) -> UnifiedDiffMeta {
    let mut meta = UnifiedDiffMeta::default();
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("@@ ") {
            if let Some(h) = parse_hunk_header(rest) {
                meta.hunks.push(h);
            }
        } else if line.starts_with("Binary files ") && line.ends_with(" differ") {
            meta.binary = true;
        } else if line == "GIT binary patch" {
            meta.binary = true;
        } else if let Some(m) = line.strip_prefix("old mode ") {
            meta.old_mode = Some(m.trim().to_string());
        } else if let Some(m) = line.strip_prefix("new mode ") {
            meta.new_mode = Some(m.trim().to_string());
        }
    }
    meta
}

fn parse_range(s: &str) -> Option<(u32, u32)> {
    let mut it = s.splitn(2, ',');
    let start = it.next()?.parse().ok()?;
    let count = match it.next() {
        Some(c) => c.parse().ok()?,
        None => 1,
    };
    Some((start, count))
}

/// "-12,3 +12,4 @@ fn x()" → Hunk
fn parse_hunk_header(rest: &str) -> Option<Hunk> {
    let mut parts = rest.split_whitespace();
    let old = parts.next()?.strip_prefix('-')?;
    let new = parts.next()?.strip_prefix('+')?;
    let (old_start, old_lines) = parse_range(old)?;
    let (new_start, new_lines) = parse_range(new)?;
    Some(Hunk {
        old_start,
        old_lines,
        new_start,
        new_lines,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version() {
        assert_eq!(parse_version("git version 2.39.3 (Apple Git-145)"), Some((2, 39, 3)));
        assert_eq!(parse_version("git version 2.45.1.windows.1\n"), Some((2, 45, 1)));
        assert_eq!(parse_version("nope"), None);
    }

    #[test]
    fn status_v2() {
        let raw = concat!(
            "# branch.oid 1234567890abcdef\0",
            "# branch.head main\0",
            "# branch.upstream origin/main\0",
            "# branch.ab +2 -1\0",
            "1 .M N... 100644 100644 100644 aaa aaa src/中文 目录/a b.ts\0",
            "1 A. N... 000000 100644 100644 000 bbb new.ts\0",
            "1 .D N... 100644 100644 000000 ccc ccc old.ts\0",
            "2 R. N... 100644 100644 100644 ddd ddd R100 b.md\0a.md\0",
            "u UU N... 100644 100644 100644 100644 e1 e2 e3 conflict.txt\0",
            "? untracked file.txt\0",
        );
        let s = parse_status_v2(raw.as_bytes());
        assert_eq!(s.branch.head.as_deref(), Some("main"));
        assert_eq!(s.branch.upstream.as_deref(), Some("origin/main"));
        assert_eq!((s.branch.ahead, s.branch.behind), (2, 1));
        assert_eq!(s.files.len(), 6);
        assert_eq!(s.files[0].path, "src/中文 目录/a b.ts");
        assert_eq!(s.files[0].kind, ChangeKind::Modified);
        assert!(!s.files[0].staged && s.files[0].unstaged);
        assert_eq!(s.files[1].kind, ChangeKind::Added);
        assert_eq!(s.files[2].kind, ChangeKind::Deleted);
        assert_eq!(s.files[3].kind, ChangeKind::Renamed);
        assert_eq!(s.files[3].orig_path.as_deref(), Some("a.md"));
        assert_eq!(s.files[4].kind, ChangeKind::Conflicted);
        assert_eq!(s.files[4].conflict.as_deref(), Some("UU"));
        assert_eq!(s.files[5].kind, ChangeKind::Untracked);
        assert_eq!(s.files[5].path, "untracked file.txt");
    }

    #[test]
    fn status_initial_detached() {
        let s = parse_status_v2(b"# branch.oid (initial)\0# branch.head (detached)\0");
        assert_eq!(s.branch.oid, None);
        assert_eq!(s.branch.head, None);
    }

    #[test]
    fn numstat() {
        let raw = b"3\t1\tsrc/a.ts\0-\t-\tlogo.png\0\x30\t0\t\0a.md\0b.md\0";
        let m = parse_numstat_z(raw);
        assert_eq!(m.get("src/a.ts"), Some(&(Some(3), Some(1))));
        assert_eq!(m.get("logo.png"), Some(&(None, None)));
        assert_eq!(m.get("b.md"), Some(&(Some(0), Some(0))));
    }

    #[test]
    fn branches() {
        let remotes = vec!["origin".to_string(), "corp/mirror".to_string()];
        let text = [
            "refs/heads/main\u{1f}abc\u{1f}*\u{1f}origin/main\u{1f}origin\u{1f}refs/heads/main\u{1f}ahead 2, behind 1\u{1f}1700000000\u{1f}feat: x",
            "refs/heads/old\u{1f}def\u{1f} \u{1f}origin/old\u{1f}origin\u{1f}refs/heads/old\u{1f}gone\u{1f}1700000001\u{1f}fix",
            "refs/remotes/origin/HEAD\u{1f}abc\u{1f} \u{1f}\u{1f}\u{1f}\u{1f}\u{1f}1700000000\u{1f}feat: x",
            "refs/remotes/corp/mirror/feature/a\u{1f}fff\u{1f} \u{1f}\u{1f}\u{1f}\u{1f}\u{1f}1700000002\u{1f}wip",
        ]
        .join("\n");
        let b = parse_branches(&text, &remotes);
        assert_eq!(b.len(), 3);
        assert!(b[0].is_head);
        assert_eq!((b[0].ahead, b[0].behind), (2, 1));
        assert_eq!(b[0].upstream_branch.as_deref(), Some("main"));
        assert!(b[1].upstream_gone);
        assert_eq!(b[2].remote.as_deref(), Some("corp/mirror"));
        assert_eq!(b[2].remote_branch.as_deref(), Some("feature/a"));
    }

    #[test]
    fn log() {
        let text = "h1\u{1f}s1\u{1f}Me\u{1f}me@x.com\u{1f}1700000000\u{1f}feat: 多目标\u{1e}\nh2\u{1f}s2\u{1f}Tom\u{1f}t@x.com\u{1f}1700000001\u{1f}fix\u{1e}\n";
        let l = parse_log(text);
        assert_eq!(l.len(), 2);
        assert_eq!(l[0].subject, "feat: 多目标");
        assert_eq!(l[1].hash, "h2");
    }

    #[test]
    fn unified() {
        let text = "diff --git a/x b/x\nold mode 100644\nnew mode 100755\n--- a/x\n+++ b/x\n@@ -3 +3,2 @@ ctx\n-a\n+b\n+c\n@@ -10,0 +12 @@\n+d\n";
        let m = parse_unified(text);
        assert_eq!(m.old_mode.as_deref(), Some("100644"));
        assert_eq!(m.new_mode.as_deref(), Some("100755"));
        assert_eq!(
            m.hunks,
            vec![
                Hunk { old_start: 3, old_lines: 1, new_start: 3, new_lines: 2 },
                Hunk { old_start: 10, old_lines: 0, new_start: 12, new_lines: 1 },
            ]
        );
        assert!(parse_unified("Binary files a/x and b/x differ\n").binary);
    }
}
