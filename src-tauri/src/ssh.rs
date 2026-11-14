//! OpenSSH wrapper and strict, typed askpass prompt decoding. No secret persistence.
use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::process::{Command, Stdio};

pub const ASKPASS_ENV: &str = "GITMANAGEMENT_SSH_ASKPASS";
pub const DESTINATION_ENV: &str = "GITMANAGEMENT_SSH_DESTINATION";
pub const CONFIG_ENV: &str = "GITMANAGEMENT_SSH_CONFIG";
pub const INTERACTIVE_ENV: &str = "GITMANAGEMENT_SSH_INTERACTIVE";

#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SshMetadata {
    pub host: Option<String>,
    pub port: Option<u16>,
    pub username: Option<String>,
    pub key_path: Option<String>,
    pub fingerprint: Option<String>,
    pub key_type: Option<String>,
    pub destination: Option<String>,
}

#[derive(Deserialize)]
pub struct SshPrompt {
    pub prompt: String,
    pub destination: Option<String>,
}
pub struct ParsedPrompt {
    pub kind: &'static str,
    pub metadata: SshMetadata,
}

fn safe(value: &str) -> bool {
    !value.is_empty() && value.len() <= 8192 && !value.chars().any(|c| c.is_control())
}
fn destination(value: &str) -> SshMetadata {
    let mut result = SshMetadata::default();
    if !safe(value) {
        return result;
    }
    result.destination = Some(value.to_string());
    if let Ok(url) = tauri::Url::parse(value) {
        if url.scheme() == "ssh" {
            result.host = url.host_str().map(String::from);
            result.port = Some(url.port().unwrap_or(22));
            result.username = (!url.username().is_empty()).then(|| url.username().to_string());
            return result;
        }
    }
    let (user, host) = value
        .rsplit_once('@')
        .map(|(u, h)| (Some(u), h))
        .unwrap_or((None, value));
    result.username = user.filter(|u| safe(u)).map(String::from);
    if let Some((host, port)) = host.strip_prefix('[').and_then(|h| h.split_once("]:")) {
        result.host = Some(host.to_string());
        result.port = port.parse().ok();
    } else {
        result.host = Some(host.trim_matches(['[', ']']).to_string());
    }
    result
}

/// Only known English OpenSSH prompts are accepted. Unknown keyboard-interactive
/// questions never receive a password, token, or automatic yes.
pub fn parse_prompt(prompt: &str, target: Option<&str>) -> AppResult<ParsedPrompt> {
    if prompt.len() > 16384 || prompt.contains('\0') {
        return Err(AppError::new("ssh.unsupportedPrompt"));
    }
    let mut metadata = target.map(destination).unwrap_or_default();
    let text = prompt.trim();
    if let Some(rest) = text.strip_prefix("Enter passphrase for key '") {
        if let Some(path) = rest.strip_suffix("':") {
            if safe(path) {
                metadata.key_path = Some(path.to_string());
                return Ok(ParsedPrompt {
                    kind: "sshPassphrase",
                    metadata,
                });
            }
        }
    }
    if let Some(account) = text.strip_suffix("'s password:") {
        if safe(account) {
            let parsed = destination(account);
            if parsed.host.is_some() {
                metadata.host = parsed.host;
            }
            if parsed.username.is_some() {
                metadata.username = parsed.username;
            }
            if metadata.destination.is_none() {
                metadata.destination = parsed.destination;
            }
            return Ok(ParsedPrompt {
                kind: "sshPassword",
                metadata,
            });
        }
    }
    if text.starts_with("The authenticity of host '")
        && text.ends_with("Are you sure you want to continue connecting (yes/no/[fingerprint])?")
    {
        let rest = text.strip_prefix("The authenticity of host '").unwrap();
        let end = rest.find("' ").or_else(|| rest.find("' can"));
        if let Some(end) = end {
            let shown = &rest[..end];
            if safe(shown) {
                let host = shown.split(" (").next().unwrap_or(shown);
                metadata.destination = Some(host.to_string());
                if let Some(host) = host.strip_prefix('[') {
                    if let Some((name, port)) = host.split_once("]:") {
                        metadata.host = Some(name.to_string());
                        metadata.port = port.parse().ok();
                    }
                } else {
                    metadata.host = Some(host.to_string());
                }
            }
        }
        for line in text.lines() {
            if let Some((kind, fingerprint)) = line
                .trim()
                .split_once(" key fingerprint is ")
                .or_else(|| line.trim().split_once(" key fingerprint is: "))
            {
                let fingerprint = fingerprint.trim_end_matches('.');
                if fingerprint.starts_with("SHA256:")
                    && fingerprint[7..].len() == 43
                    && fingerprint[7..]
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"+/=".contains(&b))
                    && ["ED25519", "ECDSA", "RSA", "DSA"].contains(&kind)
                {
                    metadata.fingerprint = Some(fingerprint.to_string());
                    metadata.key_type = Some(kind.to_string());
                }
            }
        }
        if metadata.host.is_some() && metadata.fingerprint.is_some() {
            return Ok(ParsedPrompt {
                kind: "sshHostKey",
                metadata,
            });
        }
    }
    Err(AppError::new("ssh.unsupportedPrompt"))
}

/// Early executable branch, called by OpenSSH with its prompt as argv[1].
pub fn run_askpass() -> i32 {
    let request = SshPrompt {
        prompt: std::env::args().nth(1).unwrap_or_default(),
        destination: std::env::var(DESTINATION_ENV).ok(),
    };
    let fields = match serde_json::to_string(
        &serde_json::json!({ "prompt": request.prompt, "destination": request.destination }),
    ) {
        Ok(value) => value,
        Err(_) => return 1,
    };
    match crate::auth::helper_request("ssh-askpass", fields) {
        Some(answer) => {
            println!("{}", answer);
            0
        }
        None => 1,
    }
}

/// Git's temporary ssh command. Keep transport on stdin/stdout untouched, and
/// preserve config/agent/proxy settings while enforcing explicit host checking.
pub fn run_wrapper() -> i32 {
    let args: Vec<String> = std::env::args().skip(2).collect();
    let exe = match std::env::current_exe() {
        Ok(exe) => exe,
        Err(_) => return 1,
    };
    let mut command = Command::new("ssh");
    if let Some(config) = std::env::var_os(CONFIG_ENV) {
        command.arg("-F").arg(config);
    }
    command.args(["-o", "IgnoreUnknown=UseKeychain", "-o", "UseKeychain=no"]);
    command.args([
        "-o",
        "StrictHostKeyChecking=ask",
        "-o",
        "FingerprintHash=sha256",
        "-o",
        "UpdateHostKeys=no",
        "-o",
        "AddKeysToAgent=no",
        "-o",
        "PermitLocalCommand=no",
    ]);
    if std::env::var(INTERACTIVE_ENV).as_deref() != Ok("1") {
        command.args(["-o", "BatchMode=yes"]);
    } else {
        command.args(["-o", "BatchMode=no"]);
    }
    // Git supplies options then destination then remote command. Skip known
    // option values; metadata is informational, never used to choose credentials.
    let mut skip = false;
    for arg in &args {
        if skip {
            skip = false;
            continue;
        }
        if ["-p", "-l", "-i", "-F", "-o", "-J", "-S"].contains(&arg.as_str()) {
            skip = true;
            continue;
        }
        if arg.starts_with('-') {
            continue;
        }
        command.env(DESTINATION_ENV, arg);
        break;
    }
    command
        .args(&args)
        .env("SSH_ASKPASS", exe)
        .env("SSH_ASKPASS_REQUIRE", "force")
        .env(ASKPASS_ENV, "1")
        .env("DISPLAY", "gitmanagement:0")
        .env("LC_ALL", "C")
        .env("LANGUAGE", "C")
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    match command.status() {
        Ok(status) => status.code().unwrap_or(1),
        Err(_) => {
            eprintln!("GitManagement: OpenSSH unavailable");
            127
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn typed_prompts_fail_closed() {
        let pass = parse_prompt("alice@host's password: ", Some("alice@alias")).unwrap();
        assert_eq!(pass.kind, "sshPassword");
        assert_eq!(pass.metadata.username.as_deref(), Some("alice"));
        assert_eq!(
            parse_prompt("Enter passphrase for key '/tmp/a b': ", None)
                .unwrap()
                .kind,
            "sshPassphrase"
        );
        let fingerprint = "SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
        let text = format!("The authenticity of host '[host]:2222 ([127.0.0.1]:2222)' can't be established.\nED25519 key fingerprint is {fingerprint}.\nAre you sure you want to continue connecting (yes/no/[fingerprint])? ");
        let host = parse_prompt(&text, None).unwrap();
        assert_eq!(host.kind, "sshHostKey");
        assert_eq!(host.metadata.port, Some(2222));
        for prompt in [
            "Password:",
            "Verification code:",
            "Are you sure?",
            "REMOTE HOST IDENTIFICATION HAS CHANGED!",
        ] {
            assert!(parse_prompt(prompt, None).is_err());
        }
    }
}
