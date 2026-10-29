//! 安全相关：输出脱敏、URL 内嵌凭据剥离、系统钥匙串读写（specs/07 第 6 节）。

use crate::error::{AppError, AppResult};
use regex::Regex;
use std::sync::OnceLock;

const KEYRING_SERVICE: &str = "GitManagement";

fn cred_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)(https?://)[^/@\s]+@").expect("valid regex"))
}

/// 把 `https://user:token@host` 形式脱敏为 `https://***@host`，用于命令日志与错误输出。
pub fn redact(s: &str) -> String {
    cred_re().replace_all(s, "${1}***@").into_owned()
}

#[derive(Debug, Clone, PartialEq)]
pub struct StrippedUrl {
    pub url: String,
    pub username: Option<String>,
    pub password: Option<String>,
}

/// 剥离 http(s) URL 中的 `user:password@`。只有包含密码/令牌时才剥离。
pub fn strip_url_credentials(url: &str) -> StrippedUrl {
    let unchanged = StrippedUrl {
        url: url.to_string(),
        username: None,
        password: None,
    };
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return unchanged;
    }
    let scheme_end = match url.find("://") {
        Some(i) => i + 3,
        None => return unchanged,
    };
    let rest = &url[scheme_end..];
    let host_end = rest.find('/').unwrap_or(rest.len());
    let authority = &rest[..host_end];
    let at = match authority.rfind('@') {
        Some(at) => at,
        None => return unchanged,
    };
    let userinfo = &authority[..at];
    let (user, pass) = match userinfo.find(':') {
        Some(c) => (&userinfo[..c], &userinfo[c + 1..]),
        None => return unchanged,
    };
    if pass.is_empty() {
        return unchanged;
    }
    StrippedUrl {
        url: format!("{}{}{}", &url[..scheme_end], &authority[at + 1..], &rest[host_end..]),
        username: Some(percent_decode(user)),
        password: Some(percent_decode(pass)),
    }
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
            if let Ok(v) = u8::from_str_radix(hex, 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// 凭据键：`scheme://host[:port]`，小写，不含用户名与路径。
pub fn host_key(url: &str) -> Option<String> {
    let scheme_end = url.find("://")?;
    let scheme = url[..scheme_end].to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return None;
    }
    let rest = &url[scheme_end + 3..];
    let authority = &rest[..rest.find('/').unwrap_or(rest.len())];
    let host = match authority.rfind('@') {
        Some(at) => &authority[at + 1..],
        None => authority,
    };
    if host.is_empty() {
        return None;
    }
    Some(format!("{}://{}", scheme, host.to_ascii_lowercase()))
}

fn kr_err(e: keyring::Error) -> AppError {
    AppError::new("credential.error").detail(e.to_string())
}

pub fn save_credential(key: &str, username: &str, secret: &str) -> AppResult<()> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, key).map_err(kr_err)?;
    let value = serde_json::json!({ "username": username, "secret": secret }).to_string();
    entry.set_password(&value).map_err(kr_err)
}

pub fn load_credential(key: &str) -> Option<(String, String)> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, key).ok()?;
    let raw = entry.get_password().ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    Some((
        v.get("username")?.as_str()?.to_string(),
        v.get("secret")?.as_str()?.to_string(),
    ))
}

pub fn delete_credential(key: &str) -> AppResult<()> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, key).map_err(kr_err)?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(kr_err(e)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_tokens() {
        assert_eq!(
            redact("fatal: unable to access 'https://me:ghp_abc@github.com/a/b.git/'"),
            "fatal: unable to access 'https://***@github.com/a/b.git/'"
        );
        assert_eq!(redact("git@github.com:a/b.git"), "git@github.com:a/b.git");
    }

    #[test]
    fn strips_credentials() {
        let s = strip_url_credentials("https://me:to%40ken@gitlab.corp.com/team/app.git");
        assert_eq!(s.url, "https://gitlab.corp.com/team/app.git");
        assert_eq!(s.username.as_deref(), Some("me"));
        assert_eq!(s.password.as_deref(), Some("to@ken"));

        let s = strip_url_credentials("https://me@host/app.git");
        assert_eq!(s.url, "https://me@host/app.git");
        assert!(s.password.is_none());

        let s = strip_url_credentials("git@host:app.git");
        assert_eq!(s.url, "git@host:app.git");
    }

    #[test]
    fn host_keys() {
        assert_eq!(host_key("https://me@GitHub.com/a.git").as_deref(), Some("https://github.com"));
        assert_eq!(host_key("http://host:8080").as_deref(), Some("http://host:8080"));
        assert_eq!(host_key("ssh://git@host/a"), None);
    }
}
