//! GIT_ASKPASS 实现（specs/07 第 2.2 节）。
//!
//! git 在需要 HTTPS 用户名/密码且 credential helper 没有提供时，会执行
//! `$GIT_ASKPASS "Username for 'https://host': "`，从 stdout 读取答案。
//! 我们把应用自身可执行文件设为 GIT_ASKPASS，并通过环境变量区分调用场景。
//! 找不到凭据时返回非 0，git 随即报认证失败，前端提示用户保存令牌。

use crate::security::{host_key, load_credential};

pub const ENV_FLAG: &str = "GITMANAGEMENT_ASKPASS";

pub fn is_askpass_invocation() -> bool {
    std::env::var(ENV_FLAG).map(|v| v == "1").unwrap_or(false)
}

fn quoted(prompt: &str) -> Option<&str> {
    let start = prompt.find('\'')? + 1;
    let end = prompt[start..].find('\'')? + start;
    Some(&prompt[start..end])
}

pub fn run() -> i32 {
    let prompt = std::env::args().nth(1).unwrap_or_default();
    let want_user = prompt.starts_with("Username");
    let want_pass = prompt.starts_with("Password");
    if !want_user && !want_pass {
        return 1;
    }
    let key = match quoted(&prompt).and_then(host_key) {
        Some(k) => k,
        None => return 1,
    };
    match load_credential(&key) {
        Some((user, secret)) => {
            println!("{}", if want_user { user } else { secret });
            0
        }
        None => 1,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_prompt() {
        assert_eq!(quoted("Username for 'https://github.com': "), Some("https://github.com"));
        assert_eq!(
            quoted("Password for 'https://me@github.com': ").and_then(host_key).as_deref(),
            Some("https://github.com")
        );
    }
}
