//! Interactive HTTP credentials. Secrets travel only through stdin and authenticated loopback IPC.
//! Each task owns its answers; each Git invocation gets a fresh, revocable endpoint and nonce.
use crate::credentials::{self, CredentialInput, CredentialProfile};
use crate::error::{AppError, AppResult};
use crate::git::runner::CancelToken;
use crate::security;
use crate::storage::Db;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::process::{Command, Stdio};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const ENDPOINT_ENV: &str = "GITMANAGEMENT_AUTH_ENDPOINT";
pub const NONCE_ENV: &str = "GITMANAGEMENT_AUTH_NONCE";
const MAX_MESSAGE: u64 = 65536;
const WAIT: Duration = Duration::from_secs(180);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthChallenge {
    pub id: String,
    pub task_id: Option<String>,
    pub url: String,
    pub kind: &'static str,
    pub username: Option<String>,
    pub profiles: Vec<CredentialProfile>,
    pub error: Option<String>,
    pub expires_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ssh: Option<crate::ssh::SshMetadata>,
}

// Deliberately no Debug/Serialize: answers must never enter task events or logs.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialAnswer {
    pub username: String,
    pub secret: String,
    #[serde(default)]
    pub remember: bool,
    pub name: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthResponse {
    pub id: String,
    pub credential_id: Option<String>,
    pub username: String,
    pub secret: String,
    #[serde(default)]
    pub remember: bool,
    pub name: Option<String>,
}

struct Pending {
    challenge: AuthChallenge,
    answer: Mutex<Option<Option<CredentialAnswer>>>,
    ready: Condvar,
}

pub type AuthSink = Arc<dyn Fn(&str, serde_json::Value) + Send + Sync>;
pub struct AuthBroker {
    db: Arc<Db>,
    pending: Mutex<HashMap<String, Arc<Pending>>>,
    rejected_scopes: Mutex<std::collections::HashSet<String>>,
    sink: AuthSink,
}

/// Explicit context carried by a task's cancellation token, never a global current account.
pub struct AuthContext {
    pub broker: Arc<AuthBroker>,
    pub task_id: Option<String>,
    pub interactive: bool,
    answers: Mutex<HashMap<String, CredentialAnswer>>,
    rejected: Mutex<HashMap<String, usize>>,
    secrets: Mutex<Vec<String>>,
}

impl AuthBroker {
    pub fn new(db: Arc<Db>, sink: AuthSink) -> Arc<Self> {
        Arc::new(Self {
            db,
            pending: Mutex::new(HashMap::new()),
            rejected_scopes: Mutex::new(std::collections::HashSet::new()),
            sink,
        })
    }
    pub fn context(
        self: &Arc<Self>,
        task_id: Option<String>,
        interactive: bool,
    ) -> Arc<AuthContext> {
        Arc::new(AuthContext {
            broker: self.clone(),
            task_id,
            interactive,
            answers: Mutex::new(HashMap::new()),
            rejected: Mutex::new(HashMap::new()),
            secrets: Mutex::new(Vec::new()),
        })
    }
    fn emit(&self, event: &str, value: serde_json::Value) {
        (self.sink)(event, value);
    }
    pub fn pending(&self) -> Vec<AuthChallenge> {
        self.pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .map(|p| p.challenge.clone())
            .collect()
    }
    pub fn respond(&self, response: AuthResponse) -> AppResult<()> {
        let pending = self
            .pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&response.id)
            .cloned()
            .ok_or_else(|| AppError::new("credential.expired"))?;
        if pending.challenge.expires_at <= now_ms() {
            return Err(AppError::new("credential.expired"));
        }
        if pending.challenge.kind != "https" {
            if response.credential_id.is_some() || response.remember || response.name.is_some() {
                return Err(AppError::new("ssh.invalidReply"));
            }
            let valid = if pending.challenge.kind == "sshHostKey" {
                response.secret == "yes" && pending.challenge.ssh.as_ref().and_then(|s| s.fingerprint.as_ref()).is_some()
            } else { !response.secret.is_empty() && response.secret.len() <= 16384 && !response.secret.contains(['\r', '\n', '\0']) };
            if !valid { return Err(AppError::new("ssh.invalidReply")); }
            let mut slot = pending.answer.lock().unwrap_or_else(|e| e.into_inner());
            if slot.is_some() { return Err(AppError::new("credential.expired")); }
            *slot = Some(Some(CredentialAnswer { username: String::new(), secret: response.secret, remember: false, name: None }));
            pending.ready.notify_all();
            return Ok(());
        }
        let answer = if let Some(id) = response.credential_id {
            if !pending.challenge.profiles.iter().any(|p| p.id == id) {
                return Err(AppError::new("credential.mismatch"));
            }
            let (profile, secret) = credentials::load(&self.db, &id)?;
            if security::host_key(&profile.url).as_deref() != Some(&pending.challenge.url) {
                return Err(AppError::new("credential.mismatch"));
            }
            CredentialAnswer {
                username: profile.username,
                secret,
                remember: false,
                name: None,
            }
        } else {
            CredentialAnswer {
                username: response.username.trim().to_string(),
                secret: response.secret,
                remember: response.remember,
                name: response.name,
            }
        };
        validate_answer(&answer)?;
        if pending
            .challenge
            .username
            .as_ref()
            .is_some_and(|u| u != &answer.username)
        {
            return Err(AppError::new("credential.mismatch"));
        }
        let mut slot = pending.answer.lock().unwrap_or_else(|e| e.into_inner());
        if slot.is_some() {
            return Err(AppError::new("credential.expired"));
        }
        *slot = Some(Some(answer));
        pending.ready.notify_all();
        Ok(())
    }
    pub fn cancel(&self, id: &str) {
        if let Some(p) = self
            .pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(id)
            .cloned()
        {
            let mut slot = p.answer.lock().unwrap_or_else(|e| e.into_inner());
            if slot.is_none() {
                *slot = Some(None);
                p.ready.notify_all();
            }
        }
    }
    pub fn cancel_all(&self) {
        for p in self
            .pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
        {
            *p.answer.lock().unwrap_or_else(|e| e.into_inner()) = Some(None);
            p.ready.notify_all();
        }
    }
    fn ask(
        &self,
        context: &AuthContext,
        url: &str,
        username: Option<String>,
        cancel: &CancelToken,
        error: Option<&str>,
    ) -> AppResult<CredentialAnswer> {
        if cancel.is_cancelled() { return Err(AppError::new("task.cancelled")); }
        if !context.interactive {
            return Err(AppError::new("git.authFailed"));
        }
        let profiles = credentials::matching(&self.db, url)?;
        let challenge = AuthChallenge {
            id: uuid::Uuid::new_v4().to_string(),
            task_id: context.task_id.clone(),
            url: security::host_key(url)
                .ok_or_else(|| AppError::new("credential.unsupportedUrl"))?,
            kind: "https",
            username,
            profiles,
            error: error.map(String::from),
            expires_at: now_ms() + WAIT.as_millis() as u64,
            ssh: None,
        };
        self.wait_challenge(challenge, cancel)
    }
    fn wait_challenge(&self, challenge: AuthChallenge, cancel: &CancelToken) -> AppResult<CredentialAnswer> {
        let pending = Arc::new(Pending {
            challenge: challenge.clone(),
            answer: Mutex::new(None),
            ready: Condvar::new(),
        });
        self.pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(challenge.id.clone(), pending.clone());
        self.emit("auth-challenge", serde_json::to_value(&challenge)?);
        let deadline = Instant::now() + WAIT;
        let mut slot = pending.answer.lock().unwrap_or_else(|e| e.into_inner());
        while slot.is_none() && !cancel.is_cancelled() && Instant::now() < deadline {
            slot = pending
                .ready
                .wait_timeout(slot, Duration::from_millis(100))
                .unwrap_or_else(|e| e.into_inner())
                .0;
        }
        let answer = slot.take();
        drop(slot);
        self.pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&challenge.id);
        self.emit("auth-resolved", serde_json::json!({ "id": challenge.id }));
        match answer {
            Some(Some(answer)) if !cancel.is_cancelled() => Ok(answer),
            Some(None) => {
                cancel.cancel_task();
                Err(AppError::new("task.cancelled"))
            }
            _ if cancel.is_cancelled() => Err(AppError::new("task.cancelled")),
            _ => Err(AppError::new("credential.timeout")),
        }
    }
}

impl AuthContext {
    fn ssh_answer(&self, fields: &str, cancel: &CancelToken) -> AppResult<String> {
        if cancel.is_cancelled() { return Err(AppError::new("task.cancelled")); }
        if !self.interactive { return Err(AppError::new("git.authFailed")); }
        let request: crate::ssh::SshPrompt = serde_json::from_str(fields).map_err(|_| AppError::new("ssh.unsupportedPrompt"))?;
        let parsed = crate::ssh::parse_prompt(&request.prompt, request.destination.as_deref())?;
        let challenge = AuthChallenge {
            id: uuid::Uuid::new_v4().to_string(), task_id: self.task_id.clone(),
            url: parsed.metadata.destination.clone().or_else(|| parsed.metadata.host.clone()).unwrap_or_else(|| "SSH".into()),
            kind: parsed.kind, username: parsed.metadata.username.clone(), profiles: Vec::new(), error: None,
            expires_at: now_ms() + WAIT.as_millis() as u64, ssh: Some(parsed.metadata),
        };
        let answer = self.broker.wait_challenge(challenge, cancel)?;
        if parsed.kind != "sshHostKey" {
            let mut secrets = self.secrets.lock().unwrap_or_else(|e| e.into_inner());
            if !secrets.contains(&answer.secret) { secrets.push(answer.secret.clone()); }
        }
        Ok(answer.secret)
    }
    pub fn for_task(&self, task_id: &str) -> Arc<Self> {
        Arc::new(Self {
            broker: self.broker.clone(),
            task_id: Some(task_id.to_string()),
            interactive: self.interactive,
            answers: Mutex::new(
                self.answers
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .clone(),
            ),
            rejected: Mutex::new(HashMap::new()),
            secrets: Mutex::new(
                self.secrets
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .clone(),
            ),
        })
    }
    fn cache(&self, key: String, answer: CredentialAnswer) {
        let mut secrets = self.secrets.lock().unwrap_or_else(|e| e.into_inner());
        if !secrets.contains(&answer.secret) {
            secrets.push(answer.secret.clone());
        }
        drop(secrets);
        self.answers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(key, answer);
    }
    pub fn set_initial(
        &self,
        url: &str,
        profile_id: Option<&str>,
        answer: Option<CredentialAnswer>,
    ) -> AppResult<()> {
        if profile_id.is_some() && answer.is_some() {
            return Err(AppError::new("credential.invalid"));
        }
        let key = security::host_key(url);
        if (profile_id.is_some() || answer.is_some()) && key.is_none() {
            return Err(AppError::new("credential.unsupportedUrl"));
        }
        let answer = if let Some(id) = profile_id {
            let (profile, secret) = credentials::load(&self.broker.db, id)?;
            if Some(profile.url.clone()) != key {
                return Err(AppError::new("credential.mismatch"));
            }
            Some(CredentialAnswer {
                username: profile.username,
                secret,
                remember: false,
                name: None,
            })
        } else {
            answer
        };
        if let Some(answer) = answer {
            validate_answer(&answer)?;
            if security::http_scope(url)
                .and_then(|(_, u)| u)
                .is_some_and(|u| u != answer.username)
            {
                return Err(AppError::new("credential.mismatch"));
            }
            self.cache(key.unwrap(), answer);
        }
        Ok(())
    }
    pub fn has_answer(&self, url: &str) -> bool {
        security::host_key(url)
            .map(|k| {
                self.answers
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .contains_key(&k)
            })
            .unwrap_or(false)
    }
    pub fn rejected(&self, url: &str) {
        if let Some(key) = security::host_key(url) {
            // No secrets are shared across tasks. Remember only rejected scopes so
            // the next explicit attempt asks instead of reusing an expired helper token.
            self.broker.rejected_scopes.lock().unwrap_or_else(|e| e.into_inner()).insert(key.clone());
            self.answers
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&key);
            *self
                .rejected
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .entry(key)
                .or_default() += 1;
        }
    }
    pub fn request_replacement(&self, url: &str, cancel: &CancelToken) -> AppResult<()> {
        self.request_input(url, cancel, "credential.rejected")
    }
    pub fn request_input(&self, url: &str, cancel: &CancelToken, reason: &str) -> AppResult<()> {
        self.rejected(url);
        let key =
            security::host_key(url).ok_or_else(|| AppError::new("credential.unsupportedUrl"))?;
        let username = security::http_scope(url).and_then(|(_, u)| u);
        let answer = self
            .broker
            .ask(self, url, username, cancel, Some(reason))?;
        self.cache(key, answer);
        Ok(())
    }
    fn answer(
        &self,
        url: &str,
        fields: &str,
        git: &std::path::Path,
        cwd: &std::path::Path,
        cancel: &CancelToken,
    ) -> AppResult<CredentialAnswer> {
        let (key, username) =
            security::http_scope(url).ok_or_else(|| AppError::new("credential.unsupportedUrl"))?;
        if let Some(answer) = self
            .answers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&key)
            .cloned()
            .filter(|answer| {
                username
                    .as_ref()
                    .map(|u| u == &answer.username)
                    .unwrap_or(true)
            })
        {
            return Ok(answer);
        }
        let attempts = self
            .rejected
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&key)
            .copied()
            .unwrap_or(0);
        if attempts >= 3 {
            return Err(AppError::new("git.authFailed"));
        }
        let remembered_rejection = self.broker.rejected_scopes.lock().unwrap_or_else(|e| e.into_inner()).contains(&key);
        if attempts == 0 && !remembered_rejection {
            match system_credential(git, cwd, fields, cancel) {
                Ok(Some(answer))
                    if username
                        .as_ref()
                        .map(|u| u == &answer.username)
                        .unwrap_or(true) =>
                {
                    self.cache(key, answer.clone());
                    return Ok(answer);
                }
                Err(error) if error.code == "task.cancelled" => return Err(error),
                _ => {}
            }
            let profiles = credentials::matching(&self.broker.db, url)?;
            if profiles.len() == 1 {
                let (p, secret) = match credentials::load(&self.broker.db, &profiles[0].id) {
                    Ok(value) => value,
                    Err(error) if self.interactive => {
                        self.request_input(url, cancel, &error.code)?;
                        return self.answer(url, fields, git, cwd, cancel);
                    }
                    Err(error) => return Err(error),
                };
                let answer = CredentialAnswer {
                    username: p.username,
                    secret,
                    remember: false,
                    name: None,
                };
                validate_answer(&answer)?;
                self.cache(key, answer.clone());
                return Ok(answer);
            }
            // Legacy host entries cannot be enumerated. Keep on-demand compatibility only
            // when there are no catalog candidates, never when multiple accounts exist.
            if profiles.is_empty() {
                let legacy = match security::load_credential_result(&key) {
                    Ok(value) => value,
                    Err(error) if self.interactive => {
                        self.request_input(url, cancel, &error.code)?;
                        return self.answer(url, fields, git, cwd, cancel);
                    }
                    Err(error) => return Err(error),
                };
                if let Some((user, secret)) = legacy {
                    if username.as_ref().map(|u| u == &user).unwrap_or(true) {
                        let answer = CredentialAnswer {
                            username: user,
                            secret,
                            remember: false,
                            name: None,
                        };
                        validate_answer(&answer)?;
                        self.cache(key, answer.clone());
                        return Ok(answer);
                    }
                }
            }
        }
        let answer = self.broker.ask(
            self,
            url,
            username,
            cancel,
            if attempts > 0 || remembered_rejection {
                Some("credential.rejected")
            } else {
                None
            },
        )?;
        self.cache(key, answer.clone());
        Ok(answer)
    }
    fn accepted(&self, url: &str) {
        let Some(key) = security::host_key(url) else {
            return;
        };
        // Keep the rejection marker for this application run: a one-time success
        // must not cause the next task to reselect the still-expired external token.
        let answer = {
            let mut answers = self.answers.lock().unwrap_or_else(|e| e.into_inner());
            let Some(answer) = answers.get_mut(&key) else {
                return;
            };
            if !answer.remember {
                return;
            }
            answer.remember = false;
            answer.clone()
        };
        let result = credentials::save(
            &self.broker.db,
            CredentialInput {
                id: None,
                name: answer
                    .name
                    .filter(|s| !s.trim().is_empty())
                    .unwrap_or_else(|| format!("{} ({})", answer.username, key)),
                url: key,
                username: answer.username,
                secret: Some(answer.secret),
            },
        );
        if result.is_err() {
            self.broker.emit(
                "auth-warning",
                serde_json::json!({"code": "credential.saveFailed"}),
            );
        }
    }
    pub fn scrub(&self, text: &str) -> String {
        let mut clean = security::redact(text);
        let mut secrets = self
            .secrets
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        secrets.sort_by_key(|s| std::cmp::Reverse(s.len()));
        for secret in secrets {
            if !secret.is_empty() {
                clean = clean.replace(&secret, "***");
            }
        }
        clean
    }
}

pub fn validate_answer(answer: &CredentialAnswer) -> AppResult<()> {
    if answer.username.trim().is_empty()
        || answer.secret.is_empty()
        || answer.secret.len() > 16384
        || answer.username.len() > 4096
        || [&answer.username, &answer.secret]
            .iter()
            .any(|v| v.contains(['\r', '\n', '\0']))
    {
        return Err(AppError::new("credential.invalid"));
    }
    Ok(())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

// Helper protocol is bounded; neither requests nor responses derive Debug.
#[derive(Serialize, Deserialize)]
struct WireRequest {
    nonce: String,
    action: String,
    fields: String,
}
#[derive(Serialize, Deserialize)]
struct WireResponse {
    answer: Option<String>,
}

pub struct Invocation {
    pub endpoint: String,
    pub nonce: String,
    stop: Arc<std::sync::atomic::AtomicBool>,
    cancel: CancelToken,
    error: Arc<Mutex<Option<AppError>>>,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl Invocation {
    pub fn start(
        context: Arc<AuthContext>,
        cancel: CancelToken,
        git: std::path::PathBuf,
    ) -> AppResult<Self> {
        Self::start_in(context, cancel, git, std::env::temp_dir())
    }
    pub fn start_in(
        context: Arc<AuthContext>,
        cancel: CancelToken,
        git: std::path::PathBuf,
        cwd: std::path::PathBuf,
    ) -> AppResult<Self> {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))?;
        listener.set_nonblocking(true)?;
        let endpoint = listener.local_addr()?.to_string();
        let nonce = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        let expected = nonce.clone();
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let stopped = stop.clone();
        let invocation_cancel = cancel.clone();
        let error = Arc::new(Mutex::new(None));
        let errors = error.clone();
        let thread = std::thread::spawn(move || {
            let mut workers = Vec::new();
            while !stopped.load(std::sync::atomic::Ordering::SeqCst) && !cancel.is_cancelled() {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        // A single Git command invokes credential helpers serially. Reject
                        // unauthenticated/oversized connections before any GUI or secret read.
                        // Accepted sockets can inherit O_NONBLOCK (notably on macOS).
                        // A timeout does not clear it: fragmented JSON would be discarded
                        // on WouldBlock, and response writes could be truncated as well.
                        if stream.set_nonblocking(false).is_err()
                            || stream.set_read_timeout(Some(Duration::from_secs(2))).is_err()
                            || stream.set_write_timeout(Some(Duration::from_secs(2))).is_err()
                        {
                            continue;
                        }
                        let mut raw = String::new();
                        let parsed = BufReader::new((&mut stream).take(MAX_MESSAGE + 1))
                            .read_line(&mut raw)
                            .is_ok();
                        if !parsed || raw.len() as u64 > MAX_MESSAGE {
                            continue;
                        }
                        let Ok(request) = serde_json::from_str::<WireRequest>(&raw) else {
                            continue;
                        };
                        if request.nonce != expected {
                            continue;
                        }
                        let ctx = context.clone();
                        let token = cancel.clone();
                        let git = git.clone();
                        let cwd = cwd.clone();
                        let alive = stopped.clone();
                        let errors = errors.clone();
                        // Keep a strict per-invocation limit, and reap completed workers.
                        workers.retain(|h: &std::thread::JoinHandle<()>| !h.is_finished());
                        if workers.len() >= 4 {
                            continue;
                        }
                        workers.push(std::thread::spawn(move || {
                            let answer = if alive.load(std::sync::atomic::Ordering::SeqCst) {
                                None
                            } else {
                                match handle_request(&ctx, &token, &git, &cwd, &request) {
                                    Ok(answer) => answer,
                                    Err(error) => {
                                        *errors.lock().unwrap_or_else(|e| e.into_inner()) =
                                            Some(error);
                                        None
                                    }
                                }
                            };
                            let _ = serde_json::to_writer(&mut stream, &WireResponse { answer });
                            let _ = stream.write_all(b"\n");
                        }));
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(20))
                    }
                    Err(_) => break,
                }
            }
            // Workers observe the same cancellation token. Invocation drop cancels its
            // private token, never the parent task, and wakes waits within 100ms.
            for worker in workers {
                let _ = worker.join();
            }
        });
        Ok(Self {
            endpoint,
            nonce,
            stop,
            cancel: invocation_cancel,
            error,
            thread: Some(thread),
        })
    }
    pub fn error(&self) -> Option<AppError> {
        self.error.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
}
impl Drop for Invocation {
    fn drop(&mut self) {
        self.stop.store(true, std::sync::atomic::Ordering::SeqCst);
        self.cancel.cancel();
        // Usually no workers remain: Git waits for every helper before exiting.
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn handle_request(
    context: &AuthContext,
    cancel: &CancelToken,
    git: &std::path::Path,
    cwd: &std::path::Path,
    request: &WireRequest,
) -> AppResult<Option<String>> {
    if request.action == "ssh-askpass" { return context.ssh_answer(&request.fields, cancel).map(Some); }
    let url = url_from_fields(&request.fields)
        .ok_or_else(|| AppError::new("credential.unsupportedUrl"))?;
    match request.action.as_str() {
        "get" => {
            let answer = context.answer(&url, &request.fields, git, cwd, cancel)?;
            Ok(Some(format!(
                "username={}\npassword={}\n\n",
                answer.username, answer.secret
            )))
        }
        "store" => {
            context.accepted(&url);
            Ok(Some(String::new()))
        }
        "erase" => {
            context.rejected(&url);
            Ok(Some(String::new()))
        }
        _ => Err(AppError::new("credential.invalid")),
    }
}

fn url_from_fields(fields: &str) -> Option<String> {
    let mut protocol = None;
    let mut host = None;
    let mut path = None;
    let mut username = None;
    for line in fields.lines() {
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        match key {
            "protocol" => protocol = Some(value),
            "host" => host = Some(value),
            "path" => path = Some(value),
            "username" => username = Some(value),
            _ => {}
        }
    }
    let protocol = protocol?;
    if protocol != "http" && protocol != "https" {
        return None;
    }
    let host = host?;
    if host.contains(['/', '@', '\\', '\r', '\n']) {
        return None;
    }
    let user = username
        .filter(|s| !s.is_empty())
        .map(|u| format!("{}@", encode_user(u)))
        .unwrap_or_default();
    let url = format!("{}://{}{}/{}", protocol, user, host, path.unwrap_or(""));
    security::host_key(&url)?;
    Some(url)
}
fn encode_user(user: &str) -> String {
    user.bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{:02X}", b)
            }
        })
        .collect()
}

/// Delegate only credential *reads* to the configured system helpers. Never call
/// approve/reject: only-once answers must not be persisted by an external helper.
fn system_credential(
    git: &std::path::Path,
    cwd: &std::path::Path,
    fields: &str,
    cancel: &CancelToken,
) -> AppResult<Option<CredentialAnswer>> {
    let safe_fields: String = fields
        .lines()
        .filter(|line| {
            ["protocol=", "host=", "path=", "username="]
                .iter()
                .any(|p| line.starts_with(p))
        })
        .map(|line| format!("{}\n", line))
        .collect();
    let mut cmd = Command::new(git);
    cmd.current_dir(cwd);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    cmd.args(["credential", "fill"])
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ASKPASS", "")
        .env("SSH_ASKPASS", "")
        .env("GCM_INTERACTIVE", "Never")
        .env("GCM_MODAL_PROMPT", "false")
        .env_remove(crate::askpass::ENV_FLAG)
        .env_remove(ENDPOINT_ENV)
        .env_remove(NONCE_ENV)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    // This runs in the main process, not the helper process, so its environment
    // does not contain Git's temporary -c credential.helper shim.
    let mut child = cmd.spawn()?;
    if let Some(mut input) = child.stdin.take() {
        let _ = writeln!(input, "{}", safe_fields);
    }
    let stdout = child.stdout.take();
    let (send, receive) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut out = String::new();
        if let Some(pipe) = stdout {
            let _ = pipe.take(MAX_MESSAGE + 1).read_to_string(&mut out);
        }
        let _ = send.send(out);
    });
    let start = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if cancel.is_cancelled() || start.elapsed() > Duration::from_secs(15) {
            crate::git::runner::kill_tree(&mut child);
            let _ = child.wait();
            // A custom helper may keep stdout open; do not block cancellation on it.
            return if cancel.is_cancelled() {
                Err(AppError::new("task.cancelled"))
            } else {
                Ok(None)
            };
        }
        std::thread::sleep(Duration::from_millis(30));
    };
    if !status.success() {
        return Ok(None);
    }
    // A custom helper may exit while a descendant holds stdout open. Bound
    // the drain as well as process execution; never hang the auth response path.
    let raw = loop {
        if cancel.is_cancelled() {
            crate::git::runner::kill_tree(&mut child);
            return Err(AppError::new("task.cancelled"));
        }
        match receive.recv_timeout(Duration::from_millis(50)) {
            Ok(raw) => break raw,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout)
                if start.elapsed() < Duration::from_secs(15) => {}
            _ => {
                crate::git::runner::kill_tree(&mut child);
                return Ok(None);
            }
        }
    };
    if raw.len() as u64 > MAX_MESSAGE {
        return Ok(None);
    }
    let mut username = None;
    let mut secret = None;
    for line in raw.lines() {
        if let Some(value) = line.strip_prefix("username=") {
            username = Some(value.to_string());
        }
        if let Some(value) = line.strip_prefix("password=") {
            secret = Some(value.to_string());
        }
    }
    let answer = match (username, secret) {
        (Some(username), Some(secret)) => CredentialAnswer {
            username,
            secret,
            remember: false,
            name: None,
        },
        _ => return Ok(None),
    };
    validate_answer(&answer)?;
    Ok(Some(answer))
}

/// Runs in the executable's early helper branch, without initializing the GUI.
pub fn run_helper(action: &str) -> i32 {
    if !["get", "store", "erase"].contains(&action) {
        return 1;
    }
    let mut fields = String::new();
    if std::io::stdin()
        .take(MAX_MESSAGE + 1)
        .read_to_string(&mut fields)
        .is_err()
        || fields.len() as u64 > MAX_MESSAGE
    {
        return 1;
    }
    match helper_request(action, fields) {
        Some(answer) => { print!("{}", answer); 0 },
        None if action == "get" => { println!("quit=true\n"); 1 },
        None => 1,
    }
}

pub fn helper_request(action: &str, fields: String) -> Option<String> {
    let endpoint = std::env::var(ENDPOINT_ENV).ok()?;
    let addr: std::net::SocketAddr = endpoint.parse().ok()?;
    if !addr.ip().is_loopback() || fields.len() as u64 > MAX_MESSAGE { return None; }
    let nonce = std::env::var(NONCE_ENV).ok()?;
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_secs(2)).ok()?;
    let _ = stream.set_read_timeout(Some(WAIT + Duration::from_secs(30)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
    if serde_json::to_writer(
        &mut stream,
        &WireRequest {
            nonce,
            action: action.to_string(),
            fields,
        },
    )
    .is_err()
        || stream.write_all(b"\n").is_err()
    {
        return None;
    }
    let mut raw = String::new();
    if BufReader::new(stream.take(MAX_MESSAGE + 1))
        .read_line(&mut raw)
        .is_err()
        || raw.len() as u64 > MAX_MESSAGE
    {
        return None;
    }
    serde_json::from_str::<WireResponse>(&raw).ok()?.answer
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn invocation_waits_for_a_complete_fragmented_request() {
        let db = Arc::new(Db::open_in_memory().unwrap());
        let broker = AuthBroker::new(db, Arc::new(|_, _| {}));
        let context = broker.context(None, false);
        context.set_initial("http://127.0.0.1:45678/repo.git", None, Some(CredentialAnswer {
            username: "integration-user".into(), secret: "fragmented-secret".into(),
            remember: false, name: None,
        })).unwrap();
        let invocation = Invocation::start(context, CancelToken::new(), crate::git::runner::detect_git(None)).unwrap();
        let request = serde_json::to_vec(&WireRequest {
            nonce: invocation.nonce.clone(), action: "get".into(),
            fields: "protocol=http\nhost=127.0.0.1:45678\npath=repo.git\n\n".into(),
        }).unwrap();
        let mut stream = TcpStream::connect(&invocation.endpoint).unwrap();
        stream.set_read_timeout(Some(Duration::from_millis(150))).unwrap();
        stream.write_all(&request[..request.len() / 2]).unwrap();
        let mut byte = [0];
        let error = stream.read(&mut byte).expect_err("incomplete request was answered or closed");
        assert!(matches!(error.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut));
        stream.write_all(&request[request.len() / 2..]).unwrap();
        stream.write_all(b"\n").unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        let mut response = String::new();
        BufReader::new(stream).read_line(&mut response).unwrap();
        let response: WireResponse = serde_json::from_str(&response).unwrap();
        assert_eq!(response.answer.as_deref(), Some("username=integration-user\npassword=fragmented-secret\n\n"));
        assert!(invocation.error().is_none());
    }

    #[test]
    fn helper_scope_validates_fields() {
        assert_eq!(
            url_from_fields(
                "protocol=https\nhost=Example.com:443\nusername=a@b\npath=team/repo.git\n"
            )
            .as_deref(),
            Some("https://a%40b@Example.com:443/team/repo.git")
        );
        assert!(url_from_fields("protocol=ssh\nhost=example.com\n").is_none());
        assert!(url_from_fields("protocol=https\nhost=evil@host\n").is_none());
    }
    #[test]
    fn answers_reject_multiline_but_preserve_password_spaces() {
        let answer = |secret: &str| CredentialAnswer {
            username: "me".into(),
            secret: secret.into(),
            remember: false,
            name: None,
        };
        assert!(validate_answer(&answer(" pass ")).is_ok());
        assert!(validate_answer(&answer("pass\nquit=true")).is_err());
        assert!(validate_answer(&answer("")).is_err());
    }
    #[test]
    fn silent_and_precancelled_requests_never_open_dialogs() {
        let db = Arc::new(Db::open_in_memory().unwrap());
        let count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let events = count.clone();
        let broker = AuthBroker::new(db, Arc::new(move |_, _| { events.fetch_add(1, std::sync::atomic::Ordering::SeqCst); }));
        let cancel = CancelToken::new();
        let silent = broker.context(None, false);
        assert_eq!(broker.ask(&silent, "https://host/repo", None, &cancel, None).err().unwrap().code, "git.authFailed");
        cancel.cancel();
        let interactive = broker.context(None, true);
        assert_eq!(broker.ask(&interactive, "https://host/repo", None, &cancel, None).err().unwrap().code, "task.cancelled");
        assert!(broker.pending().is_empty());
        assert_eq!(count.load(std::sync::atomic::Ordering::SeqCst), 0);
    }

    #[test]
    fn cancelled_challenge_is_removed_and_never_emits_secret() {
        let db = Arc::new(Db::open_in_memory().unwrap());
        let events = Arc::new(Mutex::new(Vec::<String>::new()));
        let out = events.clone();
        let broker = AuthBroker::new(
            db,
            Arc::new(move |event, value| {
                out.lock().unwrap().push(format!("{} {}", event, value));
            }),
        );
        let context = broker.context(Some("task".into()), true);
        let cancel = CancelToken::new();
        let b = broker.clone();
        let c = cancel.clone();
        let thread =
            std::thread::spawn(move || b.ask(&context, "https://host/repo", None, &c, None));
        let deadline = Instant::now() + Duration::from_secs(2);
        while broker.pending().is_empty() && Instant::now() < deadline {
            std::thread::yield_now();
        }
        let challenge = broker.pending().pop().unwrap();
        broker.cancel(&challenge.id);
        assert_eq!(thread.join().unwrap().err().unwrap().code, "task.cancelled");
        assert!(cancel.is_cancelled());
        assert!(broker.pending().is_empty());
        assert!(events
            .lock()
            .unwrap()
            .iter()
            .any(|e| e.starts_with("auth-resolved")));
    }
}
