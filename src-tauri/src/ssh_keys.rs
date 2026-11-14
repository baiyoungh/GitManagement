//! Local public-key discovery and no-clobber Ed25519 generation.
//! Passphrases travel only over a nonce-authenticated loopback socket, never argv,
//! environment variables, files, command logs, or returned error details.
use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

pub const ENV_FLAG: &str = "GITMANAGEMENT_KEYGEN_ASKPASS";
const ENDPOINT_ENV: &str = "GITMANAGEMENT_KEYGEN_ENDPOINT";
const NONCE_ENV: &str = "GITMANAGEMENT_KEYGEN_NONCE";
const MAX_PUBLIC_BYTES: usize = 16 * 1024;
const MAX_KEYS: usize = 100;
const MAX_FRAME: usize = 8192;
const TIMEOUT: Duration = Duration::from_secs(30);
const PROMPTS: [&str; 2] = [
    "Enter passphrase (empty for no passphrase):",
    "Enter same passphrase again:",
];

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SshKeyInfo {
    pub name: String,
    pub public_path: String,
    pub private_path: Option<String>,
    pub public_key: String,
    pub fingerprint: String,
    pub key_type: String,
    pub comment: String,
}

// Deliberately not Debug/Serialize: this request contains a secret.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SshKeyGenerate {
    pub name: String,
    pub comment: String,
    pub passphrase: String,
}

fn error(code: &str) -> AppError {
    AppError::new(format!("sshKeys.{code}"))
}

fn home() -> AppResult<PathBuf> {
    let variables = if cfg!(windows) {
        ["USERPROFILE", "HOME"]
    } else {
        ["HOME", "USERPROFILE"]
    };
    variables
        .into_iter()
        .filter_map(std::env::var_os)
        .map(PathBuf::from)
        .find(|p| p.is_absolute())
        .ok_or_else(|| error("homeUnavailable"))
}

pub fn default_directory() -> AppResult<String> {
    Ok(home()?.join(".ssh").to_string_lossy().into_owned())
}

pub fn list() -> AppResult<Vec<SshKeyInfo>> {
    list_directory(&home()?.join(".ssh"))
}

fn list_directory(directory: &Path) -> AppResult<Vec<SshKeyInfo>> {
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(_) => return Err(error("readFailed")),
    };
    let mut result = Vec::new();
    let mut inspected = 0;
    for entry in entries {
        let entry = entry.map_err(|_| error("readFailed"))?;
        if entry.path().extension().and_then(|s| s.to_str()) != Some("pub")
            || !entry.file_type().map(|t| t.is_file()).unwrap_or(false)
        {
            continue;
        }
        inspected += 1;
        if let Ok(info) = read_public(&entry.path()) {
            result.push(info);
        }
        if inspected >= MAX_KEYS {
            break;
        }
    }
    result.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(result)
}

/// Read one explicitly selected, regular .pub file. Never return unparsed text.
pub fn read_public(path: &Path) -> AppResult<SshKeyInfo> {
    if path.extension().and_then(|s| s.to_str()) != Some("pub") {
        return Err(error("invalidPublic"));
    }
    let before = fs::symlink_metadata(path).map_err(|_| error("readFailed"))?;
    if !before.file_type().is_file() || before.len() > MAX_PUBLIC_BYTES as u64 {
        return Err(error("invalidPublic"));
    }
    let file = open_public(path).map_err(|_| error("readFailed"))?;
    let opened = file.metadata().map_err(|_| error("readFailed"))?;
    if !opened.is_file()
        || opened.len() > MAX_PUBLIC_BYTES as u64
        || !same_metadata(&before, &opened)
    {
        return Err(error("invalidPublic"));
    }
    let mut bytes = Vec::new();
    file.take((MAX_PUBLIC_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| error("readFailed"))?;
    if bytes.len() > MAX_PUBLIC_BYTES {
        return Err(error("invalidPublic"));
    }
    let (public_key, key_type, comment, blob) =
        parse_public(&bytes).ok_or_else(|| error("invalidPublic"))?;
    if key_type.starts_with("ecdsa-") {
        // Structural wire checks cannot prove an EC point lies on its curve.
        // Feed only canonical public material, never the selected pathname or
        // any private content, to OpenSSH's cryptographic public-key decoder.
        let mut encoded = encode64(&blob);
        while encoded.len() % 4 != 0 {
            encoded.push('=');
        }
        validate_ecdsa(&format!("{key_type} {encoded}\n"))?;
    }
    let private = path.with_extension("");
    let private_path = fs::symlink_metadata(&private)
        .ok()
        .filter(|m| m.file_type().is_file())
        .map(|_| private.to_string_lossy().into_owned());
    Ok(SshKeyInfo {
        name: path
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
        public_path: path.to_string_lossy().into_owned(),
        private_path,
        public_key,
        fingerprint: format!("SHA256:{}", encode64(&Sha256::digest(&blob))),
        key_type,
        comment,
    })
}

fn validate_ecdsa(public: &str) -> AppResult<()> {
    let directory = tempfile::Builder::new()
        .prefix("gitmanagement-public-")
        .tempdir()
        .map_err(|_| error("readFailed"))?;
    let path = directory.path().join("key.pub");
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|_| error("readFailed"))?;
    file.write_all(public.as_bytes())
        .map_err(|_| error("readFailed"))?;
    drop(file);
    let mut command = Command::new(if cfg!(windows) {
        "ssh-keygen.exe"
    } else {
        "ssh-keygen"
    });
    command
        .args(["-l", "-E", "sha256", "-f"])
        .arg(&path)
        .env("LC_ALL", "C")
        .env("SSH_ASKPASS_REQUIRE", "never")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            error("missingTool")
        } else {
            error("readFailed")
        }
    })?;
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                return if status.success() {
                    Ok(())
                } else {
                    Err(error("invalidPublic"))
                }
            }
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            result => {
                crate::git::runner::kill_tree(&mut child);
                let _ = child.wait();
                return Err(error(if result.is_err() {
                    "readFailed"
                } else {
                    "timeout"
                }));
            }
        }
    }
}

fn open_public(path: &Path) -> std::io::Result<File> {
    open_regular(path, false)
}

fn open_regular(path: &Path, writable: bool) -> std::io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true).write(writable);
    // Refuse a symlink substituted between symlink_metadata and open.
    #[cfg(any(
        target_os = "macos",
        target_os = "ios",
        target_os = "freebsd",
        target_os = "openbsd",
        target_os = "netbsd",
        target_os = "dragonfly"
    ))]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(0x100 | 0x4);
    } // O_NOFOLLOW
    #[cfg(any(target_os = "linux", target_os = "android"))]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(0x20000 | 0x800);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x00200000);
    } // OPEN_REPARSE_POINT
    options.open(path)
}

fn same_metadata(a: &fs::Metadata, b: &fs::Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        a.dev() == b.dev() && a.ino() == b.ino()
    }
    #[cfg(not(unix))]
    {
        a.len() == b.len()
            && a.created().ok() == b.created().ok()
            && a.modified().ok() == b.modified().ok()
    }
}

fn parse_public(bytes: &[u8]) -> Option<(String, String, String, Vec<u8>)> {
    let text = std::str::from_utf8(bytes).ok()?;
    let text = text
        .strip_suffix("\r\n")
        .or_else(|| text.strip_suffix('\n'))
        .unwrap_or(text);
    if text.is_empty() || text.chars().any(|c| c.is_control()) {
        return None;
    }
    let (algorithm, remainder) = text.split_once(' ')?;
    let remainder = remainder.trim_start_matches(' ');
    let (encoded, comment) = remainder.split_once(' ').unwrap_or((remainder, ""));
    let comment = comment.trim_matches(' ');
    let blob = decode64(encoded)?;
    let mut wire = Wire(&blob);
    if wire.field()? != algorithm.as_bytes() {
        return None;
    }
    match algorithm {
        "ssh-ed25519" => {
            if wire.field()?.len() != 32 {
                return None;
            }
        }
        "ssh-rsa" => {
            let exponent = wire.field()?;
            let modulus = wire.field()?;
            if !positive_mpint(exponent)
                || exponent.len() > 8
                || exponent.last()? & 1 == 0
                || exponent == [1]
                || !positive_mpint(modulus)
                || !(128..=1025).contains(&modulus.len())
                || modulus.last()? & 1 == 0
            {
                return None;
            }
        }
        "ecdsa-sha2-nistp256" | "ecdsa-sha2-nistp384" | "ecdsa-sha2-nistp521" => {
            let curve = algorithm.strip_prefix("ecdsa-sha2-")?;
            if wire.field()? != curve.as_bytes() {
                return None;
            }
            let point = wire.field()?;
            let expected = match curve {
                "nistp256" => 65,
                "nistp384" => 97,
                _ => 133,
            };
            if point.len() != expected || point.first() != Some(&4) {
                return None;
            }
        }
        _ => return None,
    }
    if !wire.0.is_empty() {
        return None;
    }
    let public_key = if comment.is_empty() {
        format!("{algorithm} {encoded}")
    } else {
        format!("{algorithm} {encoded} {comment}")
    };
    Some((public_key, algorithm.to_string(), comment.to_string(), blob))
}

struct Wire<'a>(&'a [u8]);
impl<'a> Wire<'a> {
    fn field(&mut self) -> Option<&'a [u8]> {
        let length = u32::from_be_bytes(self.0.get(..4)?.try_into().ok()?) as usize;
        let value = self.0.get(4..4usize.checked_add(length)?)?;
        self.0 = &self.0[4 + length..];
        Some(value)
    }
}
fn positive_mpint(bytes: &[u8]) -> bool {
    !bytes.is_empty()
        && bytes[0] & 0x80 == 0
        && (bytes[0] != 0 || bytes.len() > 1 && bytes[1] & 0x80 != 0)
}

const BASE64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
fn encode64(bytes: &[u8]) -> String {
    let mut result = String::new();
    let mut bits = 0u32;
    let mut count = 0;
    for &byte in bytes {
        bits = (bits << 8) | u32::from(byte);
        count += 8;
        while count >= 6 {
            count -= 6;
            result.push(BASE64[((bits >> count) & 63) as usize] as char);
        }
    }
    if count != 0 {
        result.push(BASE64[((bits << (6 - count)) & 63) as usize] as char);
    }
    result
}
fn decode64(text: &str) -> Option<Vec<u8>> {
    if text.is_empty() || text.len() > MAX_PUBLIC_BYTES {
        return None;
    }
    let data = text.trim_end_matches('=');
    let padding = text.len() - data.len();
    if padding > 2
        || data.len() % 4 == 1
        || padding != 0 && (text.len() % 4 != 0 || padding != (4 - data.len() % 4) % 4)
    {
        return None;
    }
    let mut bytes = Vec::new();
    let mut bits = 0u32;
    let mut count = 0;
    for byte in data.bytes() {
        let value = BASE64.iter().position(|&b| b == byte)?;
        bits = (bits << 6) | value as u32;
        count += 6;
        if count >= 8 {
            count -= 8;
            bytes.push((bits >> count) as u8);
        }
    }
    if count != 0 && bits & ((1 << count) - 1) != 0 {
        return None;
    }
    Some(bytes)
}

fn validate(input: &SshKeyGenerate) -> AppResult<()> {
    let name = &input.name;
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved = ["CON", "PRN", "AUX", "NUL"].contains(&stem.as_str())
        || (stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.len() == 4
            && matches!(stem.as_bytes()[3], b'1'..=b'9');
    if name.is_empty()
        || name.len() > 64
        || !name.as_bytes()[0].is_ascii_alphanumeric()
        || !name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        || name.ends_with('.')
        || name.to_ascii_lowercase().ends_with(".pub")
        || reserved
    {
        return Err(error("invalidName"));
    }
    if input.comment.len() > 1024
        || input.comment.chars().any(|c| c.is_control())
        || input.passphrase.len() > 4096
        || input.passphrase.contains(['\0', '\r', '\n'])
    {
        return Err(error("generationFailed"));
    }
    Ok(())
}

pub fn generate(input: SshKeyGenerate) -> AppResult<SshKeyInfo> {
    let home = home()?;
    let helper = std::env::current_exe().map_err(|_| error("generationFailed"))?;
    generate_with_directory(&home, &helper, input)
}

/// Test seam for a real application helper. Not a Tauri command; production callers
/// must use generate(), which fixes both the home directory and helper executable.
#[doc(hidden)]
pub fn generate_with_directory(
    home: &Path,
    helper: &Path,
    input: SshKeyGenerate,
) -> AppResult<SshKeyInfo> {
    validate(&input)?;
    if !home.is_absolute() || !home.is_dir() {
        return Err(error("homeUnavailable"));
    }
    let directory = home.join(".ssh");
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    match builder.create(&directory) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(_) => return Err(error("generationFailed")),
    }
    if !fs::symlink_metadata(&directory)
        .map(|m| m.file_type().is_dir())
        .unwrap_or(false)
    {
        return Err(error("generationFailed"));
    }
    let private = directory.join(&input.name);
    let public = directory.join(format!("{}.pub", input.name));
    require_absent(&private)?;
    require_absent(&public)?;
    let stage = tempfile::Builder::new()
        .prefix(".gitmanagement-keygen-")
        .tempdir_in(&directory)
        .map_err(|_| error("generationFailed"))?;
    let staged_private = stage.path().join("key");
    let staged_public = stage.path().join("key.pub");
    run_keygen(helper, &staged_private, &input)?;
    let mut info = read_public(&staged_public).map_err(|_| error("generationFailed"))?;
    sync_key(&staged_private, true)?;
    sync_key(&staged_public, false)?;
    // Hard links publish fully written files atomically without ever replacing an
    // existing regular file, directory, symlink, or broken symlink.
    publish(&staged_private, &staged_public, &private, &public)?;
    info.name = input.name;
    info.public_path = public.to_string_lossy().into_owned();
    info.private_path = Some(private.to_string_lossy().into_owned());
    Ok(info)
}

fn require_absent(path: &Path) -> AppResult<()> {
    match fs::symlink_metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Ok(_) => Err(error("exists")),
        Err(_) => Err(error("generationFailed")),
    }
}
fn sync_key(path: &Path, private: bool) -> AppResult<()> {
    // Windows FlushFileBuffers requires a handle opened for writing.
    let file = open_regular(path, true).map_err(|_| error("generationFailed"))?;
    if !file
        .metadata()
        .map(|m| m.file_type().is_file())
        .unwrap_or(false)
    {
        return Err(error("generationFailed"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(if private {
            0o600
        } else {
            0o644
        }))
        .map_err(|_| error("generationFailed"))?;
    }
    #[cfg(not(unix))]
    let _ = private;
    file.sync_all().map_err(|_| error("generationFailed"))
}
fn publish(
    source_private: &Path,
    source_public: &Path,
    private: &Path,
    public: &Path,
) -> AppResult<()> {
    let link = |source: &Path, target: &Path| {
        fs::hard_link(source, target).map_err(|e| {
            if e.kind() == std::io::ErrorKind::AlreadyExists {
                error("exists")
            } else {
                error("generationFailed")
            }
        })
    };
    link(source_private, private)?;
    if link(source_public, public).is_err() {
        // Never unlink a final pathname: a concurrent actor could replace even
        // our own inode between an identity check and remove_file(). Preserve
        // the already-published private key and report actionable partial state.
        return Err(error("partialGeneration"));
    }
    #[cfg(unix)]
    if File::open(private.parent().ok_or_else(|| error("generationFailed"))?)
        .and_then(|directory| directory.sync_all())
        .is_err()
    {
        return Err(error("partialGeneration"));
    }
    Ok(())
}

fn run_keygen(helper: &Path, output: &Path, input: &SshKeyGenerate) -> AppResult<()> {
    let listener =
        TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).map_err(|_| error("generationFailed"))?;
    listener
        .set_nonblocking(true)
        .map_err(|_| error("generationFailed"))?;
    let nonce = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let mut command = Command::new(if cfg!(windows) {
        "ssh-keygen.exe"
    } else {
        "ssh-keygen"
    });
    command
        .args(["-q", "-t", "ed25519", "-a", "64", "-C"])
        .arg(&input.comment)
        .arg("-f")
        .arg(output)
        .env("LC_ALL", "C")
        .env("LANG", "C")
        .env("LANGUAGE", "C")
        .env("SSH_ASKPASS", helper)
        .env("SSH_ASKPASS_REQUIRE", "force")
        .env("DISPLAY", "gitmanagement-keygen:0")
        .env(ENV_FLAG, "1")
        .env(
            ENDPOINT_ENV,
            listener
                .local_addr()
                .map_err(|_| error("generationFailed"))?
                .to_string(),
        )
        .env(NONCE_ENV, &nonce)
        .env_remove("GITMANAGEMENT_SSH_ASKPASS")
        .env_remove("GITMANAGEMENT_ASKPASS")
        .env_remove("GITMANAGEMENT_AUTH_ENDPOINT")
        .env_remove("GITMANAGEMENT_AUTH_NONCE")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            error("missingTool")
        } else {
            error("generationFailed")
        }
    })?;
    let deadline = Instant::now() + TIMEOUT;
    let mut answered = 0;
    let mut connections = 0;
    let result = loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                break if status.success() && answered == 2 {
                    Ok(())
                } else {
                    Err(error("generationFailed").param("answers", answered).param("exit", status.code().unwrap_or(-1)))
                }
            }
            Err(_) => break Err(error("generationFailed")),
            Ok(None) => {}
        }
        if Instant::now() >= deadline {
            break Err(error("timeout"));
        }
        match listener.accept() {
            Ok((mut stream, address)) => {
                connections += 1;
                if connections > 16 {
                    break Err(error("generationFailed"));
                }
                if address.ip() == std::net::IpAddr::V4(Ipv4Addr::LOCALHOST) && answered < 2 {
                    let request_deadline = deadline.min(Instant::now() + Duration::from_secs(3));
                    if let Ok(request) = read_frame(&mut stream, request_deadline, 1024) {
                        if let Some((token, prompt)) = std::str::from_utf8(&request)
                            .ok()
                            .and_then(|r| r.split_once('\n'))
                        {
                            let expected = if answered == 0 {
                                prompt.trim() == PROMPTS[0]
                                    || prompt.trim() == format!("Enter passphrase for \"{}\" (empty for no passphrase):", output.display())
                            } else {
                                prompt.trim() == PROMPTS[1]
                            };
                            if constant_eq(token.as_bytes(), nonce.as_bytes()) && expected {
                                // Increment before writing: a disconnected helper never gets a retry.
                                answered += 1;
                                if write_frame(
                                    &mut stream,
                                    input.passphrase.as_bytes(),
                                    request_deadline,
                                )
                                .is_err()
                                {
                                    break Err(error("generationFailed"));
                                }
                            }
                        }
                    }
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(10))
            }
            Err(_) => break Err(error("generationFailed")),
        }
    };
    if result.is_err() {
        crate::git::runner::kill_tree(&mut child);
        let _ = child.wait();
    }
    result
}

fn constant_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |v, (a, b)| v | (a ^ b)) == 0
}
fn remaining(deadline: Instant) -> std::io::Result<Duration> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|d| !d.is_zero())
        .ok_or_else(|| std::io::Error::from(std::io::ErrorKind::TimedOut))
}
fn read_exact_bounded(
    stream: &mut TcpStream,
    mut bytes: &mut [u8],
    deadline: Instant,
) -> std::io::Result<()> {
    while !bytes.is_empty() {
        stream.set_read_timeout(Some(remaining(deadline)?))?;
        let n = stream.read(bytes)?;
        if n == 0 {
            return Err(std::io::ErrorKind::UnexpectedEof.into());
        }
        bytes = &mut bytes[n..];
    }
    Ok(())
}
fn read_frame(stream: &mut TcpStream, deadline: Instant, limit: usize) -> std::io::Result<Vec<u8>> {
    let mut header = [0; 4];
    read_exact_bounded(stream, &mut header, deadline)?;
    let length = u32::from_be_bytes(header) as usize;
    if length > limit {
        return Err(std::io::ErrorKind::InvalidData.into());
    }
    let mut bytes = vec![0; length];
    read_exact_bounded(stream, &mut bytes, deadline)?;
    Ok(bytes)
}
fn write_frame(stream: &mut TcpStream, bytes: &[u8], deadline: Instant) -> std::io::Result<()> {
    if bytes.len() > MAX_FRAME {
        return Err(std::io::ErrorKind::InvalidData.into());
    }
    let mut frame = Vec::with_capacity(bytes.len() + 4);
    frame.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
    frame.extend_from_slice(bytes);
    let mut remaining_bytes = frame.as_slice();
    while !remaining_bytes.is_empty() {
        stream.set_write_timeout(Some(remaining(deadline)?))?;
        let n = stream.write(remaining_bytes)?;
        if n == 0 {
            return Err(std::io::ErrorKind::WriteZero.into());
        }
        remaining_bytes = &remaining_bytes[n..];
    }
    Ok(())
}

/// Early executable branch for ssh-keygen's SSH_ASKPASS. No Tauri initialization.
fn known_prompt(prompt: &str) -> bool {
    let prompt = prompt.trim();
    PROMPTS.contains(&prompt)
        || prompt
            .strip_prefix("Enter passphrase for \"")
            .and_then(|rest| rest.strip_suffix("\" (empty for no passphrase):"))
            .map(|path| {
                !path.is_empty()
                    && path.len() <= 4096
                    && !path.chars().any(|c| c.is_control() || c == '"')
            })
            .unwrap_or(false)
}

pub fn run_askpass() -> i32 {
    fn run() -> Option<()> {
        if std::env::var(ENV_FLAG).ok()?.as_str() != "1" {
            return None;
        }
        let prompt = std::env::args().nth(1)?;
        if !known_prompt(&prompt) {
            return None;
        }
        let endpoint = std::env::var(ENDPOINT_ENV).ok()?;
        if endpoint.len() > 64 {
            return None;
        }
        let endpoint: SocketAddr = endpoint.parse().ok()?;
        if endpoint.ip() != std::net::IpAddr::V4(Ipv4Addr::LOCALHOST) || endpoint.port() == 0 {
            return None;
        }
        let nonce = std::env::var(NONCE_ENV).ok()?;
        if nonce.len() != 64 || !nonce.bytes().all(|b| b.is_ascii_hexdigit()) {
            return None;
        }
        let deadline = Instant::now() + Duration::from_secs(3);
        let mut stream = TcpStream::connect_timeout(&endpoint, Duration::from_secs(1)).ok()?;
        write_frame(
            &mut stream,
            format!("{nonce}\n{prompt}").as_bytes(),
            deadline,
        )
        .ok()?;
        let answer = read_frame(&mut stream, deadline, 4096).ok()?;
        if answer.iter().any(|b| matches!(b, 0 | b'\r' | b'\n')) {
            return None;
        }
        let mut stdout = std::io::stdout().lock();
        stdout.write_all(&answer).ok()?;
        stdout.write_all(b"\n").ok()?;
        stdout.flush().ok()?;
        Some(())
    }
    if run().is_some() {
        0
    } else {
        1
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(name: &str) -> SshKeyGenerate {
        SshKeyGenerate {
            name: name.into(),
            comment: "test@example.invalid".into(),
            passphrase: String::new(),
        }
    }
    fn wire(fields: &[&[u8]]) -> Vec<u8> {
        let mut bytes = Vec::new();
        for field in fields {
            bytes.extend_from_slice(&(field.len() as u32).to_be_bytes());
            bytes.extend_from_slice(field);
        }
        bytes
    }
    fn public() -> String {
        format!(
            "ssh-ed25519 {} test@example.invalid\n",
            encode64(&wire(&[b"ssh-ed25519", &[7; 32]]))
        )
    }
    fn code<T>(result: AppResult<T>) -> String {
        result.err().expect("expected failure").code
    }

    #[test]
    fn contract_and_validation() {
        let parsed: SshKeyGenerate =
            serde_json::from_str(r#"{"name":"id_ed25519","comment":"","passphrase":""}"#).unwrap();
        assert!(validate(&parsed).is_ok());
        assert!(serde_json::from_str::<SshKeyGenerate>(
            r#"{"name":"x","comment":"","passphrase":"","home":"/tmp"}"#
        )
        .is_err());
        for name in [
            "", ".", "..", "../key", "a/b", "a\\b", "-key", "x.pub", "CON", "com1.pem", "key.",
        ] {
            assert_eq!(
                code(validate(&request(name))),
                "sshKeys.invalidName",
                "{name}"
            );
        }
        let mut input = request("id_ed25519");
        input.comment = "bad\ncomment".into();
        assert_eq!(code(validate(&input)), "sshKeys.generationFailed");
        input.comment.clear();
        input.passphrase = "secret\nnot-a-second-answer".into();
        assert_eq!(code(validate(&input)), "sshKeys.generationFailed");
    }

    #[test]
    fn public_reader_strict_and_bounded() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("id_ed25519.pub");
        fs::write(&path, public()).unwrap();
        fs::write(temp.path().join("id_ed25519"), "private must never be read").unwrap();
        let info = read_public(&path).unwrap();
        assert_eq!(info.name, "id_ed25519");
        assert_eq!(info.key_type, "ssh-ed25519");
        assert!(info.private_path.is_some());
        assert!(info.fingerprint.starts_with("SHA256:"));
        assert_eq!(info.fingerprint.len(), 50);
        let json = serde_json::to_value(info).unwrap();
        assert!(json.get("publicPath").is_some() && json.get("privatePath").is_some());
        assert!(json.get("public_path").is_none());
        for content in [
            "-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n".to_string(),
            format!("{}private secret", public()),
            format!("{}\n", public()),
            "ssh-ed25519 !!!! comment".into(),
            "ssh-rsa AAAA comment".into(),
            format!(
                "ssh-ed25519 {}",
                encode64(&wire(&[b"ssh-ed25519", &[0; 31]]))
            ),
            format!("ssh-ed25519 {}", encode64(&wire(&[b"ssh-rsa", &[0; 32]]))),
            "x".repeat(MAX_PUBLIC_BYTES + 1),
        ] {
            fs::write(&path, content).unwrap();
            assert_eq!(code(read_public(&path)), "sshKeys.invalidPublic");
        }
        assert_eq!(
            code(read_public(&temp.path().join("id_ed25519"))),
            "sshKeys.invalidPublic"
        );
    }

    #[test]
    fn rsa_ecdsa_and_base64_structure() {
        let mut modulus = vec![0x81; 129];
        modulus[0] = 0;
        let rsa = wire(&[b"ssh-rsa", &[1, 0, 1], &modulus]);
        assert!(parse_public(format!("ssh-rsa {}", encode64(&rsa)).as_bytes()).is_some());
        let mut point = vec![1; 65];
        point[0] = 4;
        let ec = wire(&[b"ecdsa-sha2-nistp256", b"nistp256", &point]);
        assert!(
            parse_public(format!("ecdsa-sha2-nistp256 {}", encode64(&ec)).as_bytes()).is_some()
        );
        for invalid in ["A", "AB", "AA===", "AA=", "AAAA=", "AA A", "AA\nA", "AA-A"] {
            assert!(decode64(invalid).is_none(), "{invalid}");
        }
        for bytes in [b"".as_slice(), b"a", b"ab", b"abc", &[255; 100]] {
            if !bytes.is_empty() {
                assert_eq!(decode64(&encode64(bytes)).unwrap(), bytes);
            }
        }
        assert_eq!(
            encode64(&Sha256::digest(b"abc")),
            "ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0"
        );
    }

    #[test]
    fn ecdsa_rejects_off_curve_point_and_accepts_generator() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("ec.pub");
        let mut invalid = vec![1; 65];
        invalid[0] = 4;
        let blob = wire(&[b"ecdsa-sha2-nistp256", b"nistp256", &invalid]);
        fs::write(&path, format!("ecdsa-sha2-nistp256 {}", encode64(&blob))).unwrap();
        assert_eq!(code(read_public(&path)), "sshKeys.invalidPublic");
        // SEC 2 NIST P-256 base point, a known valid curve point.
        let hex = "046b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c2964fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5";
        let point = (0..hex.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
            .collect::<Vec<_>>();
        let blob = wire(&[b"ecdsa-sha2-nistp256", b"nistp256", &point]);
        fs::write(&path, format!("ecdsa-sha2-nistp256 {}", encode64(&blob))).unwrap();
        assert_eq!(read_public(&path).unwrap().key_type, "ecdsa-sha2-nistp256");
    }

    #[test]
    fn list_limits_and_skips_nonpublic_files() {
        let temp = tempfile::tempdir().unwrap();
        assert!(list_directory(&temp.path().join("missing"))
            .unwrap()
            .is_empty());
        fs::write(temp.path().join("private"), "never read").unwrap();
        fs::write(temp.path().join("bad.pub"), "not a public key").unwrap();
        fs::create_dir(temp.path().join("dir.pub")).unwrap();
        for index in 0..110 {
            fs::write(temp.path().join(format!("key{index}.pub")), public()).unwrap();
        }
        let result = list_directory(temp.path()).unwrap();
        assert!(result.len() <= MAX_KEYS && result.len() >= MAX_KEYS - 1);
        assert!(result.windows(2).all(|pair| pair[0].name <= pair[1].name));
    }

    #[test]
    fn publish_collision_preserves_partial_files() {
        let temp = tempfile::tempdir().unwrap();
        let source_private = temp.path().join("stage-private");
        let source_public = temp.path().join("stage-public");
        let private = temp.path().join("key");
        let public = temp.path().join("key.pub");
        fs::write(&source_private, "own private").unwrap();
        fs::write(&source_public, "own public").unwrap();
        fs::write(&public, "existing public").unwrap();
        assert_eq!(
            code(publish(&source_private, &source_public, &private, &public)),
            "sshKeys.partialGeneration"
        );
        assert_eq!(fs::read_to_string(&private).unwrap(), "own private");
        assert_eq!(fs::read_to_string(&public).unwrap(), "existing public");
        assert_eq!(
            code(publish(&source_private, &source_public, &private, &public)),
            "sshKeys.exists"
        );
        assert_eq!(fs::read_to_string(&private).unwrap(), "own private");
        assert_eq!(fs::read_to_string(&public).unwrap(), "existing public");
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_and_existing_directory_permissions() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("real.pub");
        fs::write(&target, public()).unwrap();
        let link = temp.path().join("link.pub");
        symlink(&target, &link).unwrap();
        assert_eq!(code(read_public(&link)), "sshKeys.invalidPublic");
        let directory = temp.path().join(".ssh");
        fs::create_dir(&directory).unwrap();
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o750)).unwrap();
        symlink("missing", directory.join("id_ed25519")).unwrap();
        assert_eq!(
            code(generate_with_directory(
                temp.path(),
                Path::new("unused"),
                request("id_ed25519")
            )),
            "sshKeys.exists"
        );
        assert_eq!(
            fs::metadata(&directory).unwrap().permissions().mode() & 0o777,
            0o750
        );
        assert!(fs::symlink_metadata(directory.join("id_ed25519"))
            .unwrap()
            .file_type()
            .is_symlink());
    }

    #[test]
    fn bounded_ipc_and_authentication() {
        assert!(constant_eq(b"nonce", b"nonce"));
        assert!(!constant_eq(b"nonce", b"other"));
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let thread = std::thread::spawn(move || {
            let mut stream = TcpStream::connect(address).unwrap();
            stream.write_all(&9000u32.to_be_bytes()).unwrap();
        });
        let (mut stream, _) = listener.accept().unwrap();
        assert!(read_frame(&mut stream, Instant::now() + Duration::from_secs(1), 1024).is_err());
        thread.join().unwrap();
    }
}
