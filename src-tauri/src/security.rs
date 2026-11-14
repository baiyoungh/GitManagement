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

#[derive(Clone, PartialEq)]
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
    let host_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
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
        url: format!(
            "{}{}{}",
            &url[..scheme_end],
            &authority[at + 1..],
            &rest[host_end..]
        ),
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

/// Parsed HTTP(S) origin and optional percent-decoded account hint. Passwords
/// never participate in scope. Reject URL-parser recovery of malformed authority.
pub fn http_scope(url: &str) -> Option<(String, Option<String>)> {
    if url.chars().any(|c| c.is_whitespace() || c.is_control()) || url.contains('\\') {
        return None;
    }
    let (scheme, rest) = url.split_once("://")?;
    if !scheme.eq_ignore_ascii_case("https") && !scheme.eq_ignore_ascii_case("http") {
        return None;
    }
    let authority = rest.split(['/', '?', '#']).next()?;
    let host = authority.rsplit('@').next()?;
    if host.is_empty() || host.ends_with(':') || authority.matches('@').count() > 1 {
        return None;
    }
    let parsed = tauri::Url::parse(url).ok()?;
    parsed.host_str()?;
    let hint = if parsed.username().is_empty() {
        None
    } else {
        let encoded = parsed.username().as_bytes();
        let mut decoded = Vec::new();
        let mut i = 0;
        while i < encoded.len() {
            if encoded[i] == b'%' {
                let hex = std::str::from_utf8(encoded.get(i + 1..i + 3)?).ok()?;
                decoded.push(u8::from_str_radix(hex, 16).ok()?);
                i += 3;
            } else {
                decoded.push(encoded[i]);
                i += 1;
            }
        }
        let hint = String::from_utf8(decoded).ok()?;
        if hint.chars().any(char::is_control) {
            return None;
        }
        Some(hint)
    };
    Some((parsed.origin().ascii_serialization(), hint))
}

/// Credential scope is scheme + normalized authority, never userinfo or path.
pub fn host_key(url: &str) -> Option<String> {
    http_scope(url).map(|(origin, _)| origin)
}

fn kr_err(e: keyring::Error) -> AppError {
    // Backend errors can contain credential data (notably Ambiguous). Never
    // format them, even into debug/detail fields.
    AppError::new(match e {
        keyring::Error::NoStorageAccess(_) => "credential.accessDenied",
        keyring::Error::NoEntry => "credential.notFound",
        _ => "credential.error",
    })
}

pub fn save_credential(key: &str, username: &str, secret: &str) -> AppResult<()> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, key).map_err(kr_err)?;
    let value = serde_json::json!({ "username": username, "secret": secret }).to_string();
    entry.set_password(&value).map_err(kr_err)
}

/// None means NoEntry only. Access denial and malformed stored values are errors.
pub fn load_credential_result(key: &str) -> AppResult<Option<(String, String)>> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, key).map_err(kr_err)?;
    let raw = match entry.get_password() {
        Ok(raw) => raw,
        Err(keyring::Error::NoEntry) => return Ok(None),
        Err(e) => return Err(kr_err(e)),
    };
    decode_credential(&raw).map(Some)
}

fn decode_credential(raw: &str) -> AppResult<(String, String)> {
    let invalid = || AppError::new("credential.invalidStoredValue");
    let v: serde_json::Value = serde_json::from_str(raw).map_err(|_| invalid())?;
    Ok((
        v.get("username")
            .and_then(|v| v.as_str())
            .ok_or_else(invalid)?
            .to_string(),
        v.get("secret")
            .and_then(|v| v.as_str())
            .ok_or_else(invalid)?
            .to_string(),
    ))
}

/// Legacy callers intentionally retain their best-effort behavior.
pub fn load_credential(key: &str) -> Option<(String, String)> {
    load_credential_result(key).ok().flatten()
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
    fn canonical_http_authorities() {
        for (url, expected) in [
            (
                "HTTPS://ALICE:ignored@GitHub.com:443/a?x#y",
                "https://github.com",
            ),
            ("http://Host:80?query", "http://host"),
            ("https://host:8443#fragment", "https://host:8443"),
            ("https://[2001:db8::1]:443/a", "https://[2001:db8::1]"),
            ("https://host?next=https://elsewhere", "https://host"),
        ] {
            assert_eq!(host_key(url).as_deref(), Some(expected));
        }
        for malformed in [
            "https:///missing",
            "https://",
            "https://?x",
            "https://host:",
            "https://host:abc",
            "https://host:65536",
            "https://a b",
            "https://host\\evil",
            "https://a@b@host",
            "https://[bad]",
            "https://host\n",
        ] {
            assert_eq!(host_key(malformed), None, "{malformed:?}");
        }
        assert_eq!(
            http_scope("https://a%40b:password@host/a")
                .unwrap()
                .1
                .as_deref(),
            Some("a@b")
        );
        assert!(http_scope("https://a%zz@host").is_none());
    }

    #[test]
    fn keyring_errors_and_malformed_values_are_sanitized() {
        let denied = kr_err(keyring::Error::NoStorageAccess(Box::new(
            std::io::Error::other("SECRET"),
        )));
        assert_eq!(denied.code, "credential.accessDenied");
        assert!(!format!("{denied:?}").contains("SECRET"));
        let error = kr_err(keyring::Error::Invalid("SECRET".into(), "SECRET".into()));
        assert!(!format!("{error:?}").contains("SECRET"));
        let error = decode_credential("SECRET").unwrap_err();
        assert!(!format!("{error:?}").contains("SECRET"));
    }

    #[test]
    fn host_keys() {
        assert_eq!(
            host_key("https://me@GitHub.com/a.git").as_deref(),
            Some("https://github.com")
        );
        assert_eq!(
            host_key("http://host:8080").as_deref(),
            Some("http://host:8080")
        );
        assert_eq!(host_key("ssh://git@host/a"), None);
    }
}
