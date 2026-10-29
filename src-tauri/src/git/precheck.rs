//! 提交前检查（specs/04 第 2.3 节）：超大文件、疑似密钥、TODO。
//!
//! 只检查本次新增的行（相对 HEAD），避免历史遗留内容反复报警。结果仅作提示，由用户决定是否继续提交。

use super::runner::RunOpts;
use super::Repo;
use crate::error::AppResult;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PrecheckOpts {
    pub large_file_mb: u64,
    pub secrets: bool,
    pub todo: bool,
}

impl Default for PrecheckOpts {
    fn default() -> Self {
        Self { large_file_mb: 10, secrets: true, todo: false }
    }
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum IssueKind {
    LargeFile,
    Secret,
    Todo,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PrecheckIssue {
    pub kind: IssueKind,
    pub path: String,
    pub line: Option<u32>,
    /// 命中规则名称（密钥）或文件大小（字节）
    pub detail: String,
}

fn secret_rules() -> &'static Vec<(&'static str, Regex)> {
    static R: OnceLock<Vec<(&'static str, Regex)>> = OnceLock::new();
    R.get_or_init(|| {
        [
            ("awsAccessKey", r"\b(AKIA|ASIA)[0-9A-Z]{16}\b"),
            ("privateKey", r"-----BEGIN ([A-Z]+ )?PRIVATE KEY-----"),
            ("githubToken", r"\bgh[pousr]_[A-Za-z0-9]{36,}\b"),
            ("gitlabToken", r"\bglpat-[A-Za-z0-9_\-]{20,}\b"),
            ("slackToken", r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b"),
            ("genericSecret", r#"(?i)\b(password|passwd|secret|api[_-]?key|access[_-]?token)\b\s*[:=]\s*["'][^"'\s]{8,}["']"#),
        ]
        .into_iter()
        .map(|(n, p)| (n, Regex::new(p).expect("valid regex")))
        .collect()
    })
}

fn todo_rule() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"\b(TODO|FIXME|XXX)\b").expect("valid regex"))
}

/// 检查一组新增行（行号, 内容）
pub fn scan_lines<'a>(path: &str, lines: impl Iterator<Item = (u32, &'a str)>, opts: &PrecheckOpts, out: &mut Vec<PrecheckIssue>) {
    for (no, l) in lines {
        if opts.secrets {
            if let Some((name, _)) = secret_rules().iter().find(|(_, re)| re.is_match(l)) {
                out.push(PrecheckIssue { kind: IssueKind::Secret, path: path.into(), line: Some(no), detail: (*name).into() });
            }
        }
        if opts.todo && todo_rule().is_match(l) {
            out.push(PrecheckIssue { kind: IssueKind::Todo, path: path.into(), line: Some(no), detail: l.trim().chars().take(120).collect() });
        }
    }
}

/// 从 `git diff -U0` 输出中取出新增行及其新文件行号
pub fn added_lines(diff: &str) -> Vec<(u32, String)> {
    let mut out = Vec::new();
    let mut next = 0u32;
    for l in diff.lines() {
        if let Some(rest) = l.strip_prefix("@@ ") {
            next = rest
                .split_whitespace()
                .nth(1)
                .and_then(|s| s.strip_prefix('+'))
                .and_then(|s| s.split(',').next())
                .and_then(|s| s.parse().ok())
                .unwrap_or(0);
        } else if let Some(c) = l.strip_prefix('+') {
            if !l.starts_with("+++") {
                out.push((next, c.to_string()));
                next += 1;
            }
        }
    }
    out
}

pub fn run(repo: &Repo, paths: &[String], opts: &PrecheckOpts) -> AppResult<Vec<PrecheckIssue>> {
    let mut issues = Vec::new();
    let has_head = repo.head_oid().is_some();
    for p in paths {
        let abs = repo.join(p)?;
        let Ok(md) = std::fs::metadata(&abs) else { continue };
        if !md.is_file() {
            continue;
        }
        if opts.large_file_mb > 0 && md.len() > opts.large_file_mb * 1024 * 1024 {
            issues.push(PrecheckIssue { kind: IssueKind::LargeFile, path: p.clone(), line: None, detail: md.len().to_string() });
            continue;
        }
        if !opts.secrets && !opts.todo {
            continue;
        }
        let tracked = has_head
            && repo
                .exec(&["cat-file", "-e", format!("HEAD:{}", p).as_str()], &RunOpts::read())
                .map(|o| o.code == 0)
                .unwrap_or(false);
        if tracked {
            let out = repo.exec(&["diff", "--no-ext-diff", "--no-color", "-U0", "HEAD", "--", p.as_str()], &RunOpts::read())?;
            let lines = added_lines(&out.text());
            scan_lines(p, lines.iter().map(|(n, s)| (*n, s.as_str())), opts, &mut issues);
        } else {
            let bytes = std::fs::read(&abs)?;
            if bytes.iter().take(8000).any(|&c| c == 0) {
                continue;
            }
            let text = String::from_utf8_lossy(&bytes);
            scan_lines(p, text.lines().enumerate().map(|(i, l)| (i as u32 + 1, l)), opts, &mut issues);
        }
    }
    Ok(issues)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_secrets_and_todo() {
        let opts = PrecheckOpts { large_file_mb: 10, secrets: true, todo: true };
        let mut out = Vec::new();
        let lines = [
            "const k = 'AKIAABCDEFGHIJKLMNOP';",
            "-----BEGIN RSA PRIVATE KEY-----",
            "password = \"hunter2hunter2\"",
            "// TODO: 清理",
            "let normal = 1;",
        ];
        scan_lines("a.ts", lines.iter().enumerate().map(|(i, l)| (i as u32 + 1, *l)), &opts, &mut out);
        let kinds: Vec<(IssueKind, Option<u32>)> = out.iter().map(|i| (i.kind, i.line)).collect();
        assert_eq!(
            kinds,
            vec![(IssueKind::Secret, Some(1)), (IssueKind::Secret, Some(2)), (IssueKind::Secret, Some(3)), (IssueKind::Todo, Some(4))]
        );
        assert_eq!(out[0].detail, "awsAccessKey");
    }

    #[test]
    fn added_line_numbers() {
        let d = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,0 +2,2 @@\n+a\n+b\n@@ -5 +7 @@\n-old\n+new\n";
        assert_eq!(added_lines(d), vec![(2, "a".into()), (3, "b".into()), (7, "new".into())]);
    }
}
