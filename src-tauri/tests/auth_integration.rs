//! Real Git + the application credential-helper executable, entirely on loopback.
//! No global environment changes, external network, system helpers, or OS keyring.
use gitmanagement_lib::auth::{
    AuthBroker, AuthContext, AuthResponse, CredentialAnswer, Invocation, ENDPOINT_ENV, NONCE_ENV,
};
use gitmanagement_lib::credentials;
use gitmanagement_lib::error::AppResult;
use gitmanagement_lib::git::runner::{detect_git, CancelToken, GitOutput, GitRunner, RunOpts};
use gitmanagement_lib::storage::Db;
use serde_json::Value;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

const USER: &str = "integration-user";
const SECRET: &str = "integration-secret-73";
const BASIC: &str = "Basic aW50ZWdyYXRpb24tdXNlcjppbnRlZ3JhdGlvbi1zZWNyZXQtNzM=";
const TIMEOUT: Duration = Duration::from_secs(15);

/// Minimal Git smart-HTTP v0 advertisement for an empty repository. Git itself
/// performs HTTP authentication and invokes get/store/erase on the real helper.
struct HttpRemote {
    address: SocketAddr,
    stop: Arc<AtomicBool>,
    accepted: Arc<AtomicUsize>,
    rejected: Arc<AtomicUsize>,
    thread: Option<JoinHandle<()>>,
}

impl HttpRemote {
    fn new() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let accepted = Arc::new(AtomicUsize::new(0));
        let rejected = Arc::new(AtomicUsize::new(0));
        let (done, good, bad) = (stop.clone(), accepted.clone(), rejected.clone());
        let thread = thread::spawn(move || {
            while !done.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((mut stream, peer)) => {
                        assert!(peer.ip().is_loopback());
                        stream
                            .set_read_timeout(Some(Duration::from_secs(2)))
                            .unwrap();
                        stream
                            .set_write_timeout(Some(Duration::from_secs(2)))
                            .unwrap();
                        let mut reader = BufReader::new(&mut stream);
                        let mut request = String::new();
                        let mut authorized = false;
                        let mut bytes = 0;
                        loop {
                            let mut line = String::new();
                            match reader.read_line(&mut line) {
                                Ok(0) | Err(_) => break,
                                Ok(n) => bytes += n,
                            }
                            if bytes > 16384 || line == "\r\n" {
                                break;
                            }
                            if request.is_empty() {
                                request = line.clone();
                            }
                            if let Some((name, value)) = line.split_once(':') {
                                if name.eq_ignore_ascii_case("authorization")
                                    && value.trim() == BASIC
                                {
                                    authorized = true;
                                }
                            }
                        }
                        let (status, headers, body) = if authorized {
                            good.fetch_add(1, Ordering::SeqCst);
                            assert!(request
                                .starts_with("GET /repo.git/info/refs?service=git-upload-pack "));
                            (
                                "200 OK",
                                "Content-Type: application/x-git-upload-pack-advertisement\r\n",
                                "001e# service=git-upload-pack\n00000000",
                            )
                        } else {
                            bad.fetch_add(1, Ordering::SeqCst);
                            (
                                "401 Unauthorized",
                                "WWW-Authenticate: Basic realm=\"integration\"\r\n",
                                "",
                            )
                        };
                        let response = format!(
                            "HTTP/1.1 {status}\r\n{headers}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
                            body.len()
                        );
                        let _ = stream.write_all(response.as_bytes());
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(5));
                    }
                    Err(e) => panic!("HTTP fixture accept failed: {e}"),
                }
            }
        });
        Self {
            address,
            stop,
            accepted,
            rejected,
            thread: Some(thread),
        }
    }

    fn url(&self) -> String {
        format!("http://{}/repo.git", self.address)
    }
}

impl Drop for HttpRemote {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(thread) = self.thread.take() {
            // Do not double-panic when a test assertion already failed.
            if !thread::panicking() {
                thread.join().unwrap();
            }
        }
    }
}

struct Fixture {
    _directory: tempfile::TempDir,
    db: Arc<Db>,
    broker: Arc<AuthBroker>,
    context: Arc<AuthContext>,
    token: CancelToken,
    runner: Arc<GitRunner>,
    events: Arc<Mutex<Vec<(String, Value)>>>,
    challenges: mpsc::Receiver<Value>,
}

impl Fixture {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let db = Arc::new(Db::open_in_memory().unwrap());
        let events = Arc::new(Mutex::new(Vec::new()));
        let captured = events.clone();
        let (send, challenges) = mpsc::channel();
        let broker = AuthBroker::new(
            db.clone(),
            Arc::new(move |event, value| {
                captured
                    .lock()
                    .unwrap()
                    .push((event.to_owned(), value.clone()));
                if event == "auth-challenge" {
                    let _ = send.send(value);
                }
            }),
        );
        let context = broker.context(None, true);
        let token = CancelToken::new().with_auth(context.clone());
        let mut runner = GitRunner::new(detect_git(None));
        runner.set_askpass_path(PathBuf::from(env!("CARGO_BIN_EXE_gitmanagement")));
        Self {
            _directory: directory,
            db,
            broker,
            context,
            token,
            runner: Arc::new(runner),
            events,
            challenges,
        }
    }

    fn answer(&self, id: &str, secret: &str) {
        self.broker
            .respond(AuthResponse {
                id: id.into(),
                credential_id: None,
                username: USER.into(),
                secret: secret.into(),
                remember: false,
                name: None,
            })
            .unwrap();
    }

    fn challenge(&self, url: &str) -> Value {
        let value = self
            .challenges
            .recv_timeout(TIMEOUT)
            .expect("helper did not request credentials");
        assert_eq!(value["url"], url.trim_end_matches("/repo.git"));
        assert_eq!(value["error"], "credential.rejected");
        assert!(value["profiles"].as_array().unwrap().is_empty());
        assert!(value["taskId"].is_null());
        value
    }

    fn ls_remote(&self, url: &str) -> Running<GitOutput> {
        let (runner, cwd, url, token) = (
            self.runner.clone(),
            self._directory.path().to_path_buf(),
            url.to_owned(),
            self.token.clone(),
        );
        Running::start(self.token.clone(), move || {
            runner.run(
                &cwd,
                &[
                    "-c",
                    "http.proxy=",
                    "-c",
                    "protocol.version=0",
                    "ls-remote",
                    &url,
                ],
                &RunOpts {
                    cancel: Some(token),
                    ..RunOpts::read()
                },
            )
        })
    }

    fn assert_private(&self, secrets: &[&str]) {
        assert!(
            credentials::list(&self.db).unwrap().is_empty(),
            "remember=false persisted a profile"
        );
        assert!(self.broker.pending().is_empty());
        let events = serde_json::to_string(&*self.events.lock().unwrap()).unwrap();
        let logs = serde_json::to_string(&self.runner.log_entries()).unwrap();
        assert!(!self.runner.log_entries().is_empty());
        for secret in secrets.iter().copied().chain([BASIC]) {
            assert!(
                !events.contains(secret),
                "credential leaked into auth events"
            );
            assert!(
                !logs.contains(secret),
                "credential leaked into command logs"
            );
        }
    }
}

/// Cancel on panic/timeout as well as on success, so a failed assertion never
/// leaves a Git/helper child or a 180-second broker wait behind.
struct Running<T> {
    token: CancelToken,
    result: mpsc::Receiver<AppResult<T>>,
    thread: Option<JoinHandle<()>>,
}

impl<T: Send + 'static> Running<T> {
    fn start(
        token: CancelToken,
        operation: impl FnOnce() -> AppResult<T> + Send + 'static,
    ) -> Self {
        let (send, result) = mpsc::channel();
        let thread = thread::spawn(move || {
            let _ = send.send(operation());
        });
        Self {
            token,
            result,
            thread: Some(thread),
        }
    }

    fn finish(mut self) -> AppResult<T> {
        let result = self
            .result
            .recv_timeout(TIMEOUT)
            .expect("authentication operation did not finish");
        self.thread.take().unwrap().join().unwrap();
        result
    }
}

impl<T> Drop for Running<T> {
    fn drop(&mut self) {
        if let Some(thread) = self.thread.take() {
            self.token.cancel();
            let _ = thread.join();
        }
    }
}

#[test]
fn helper_submits_once_without_persisting_and_reuses_only_the_task_answer() {
    let remote = HttpRemote::new();
    let f = Fixture::new();
    let url = remote.url();
    // Mark lookup as rejected to exercise the actual helper challenge without
    // consulting any host credential helper or the legacy OS keyring.
    f.context.rejected(&url);
    let running = f.ls_remote(&url);
    let challenge = f.challenge(&url);
    f.answer(challenge["id"].as_str().unwrap(), SECRET);
    assert_eq!(running.finish().unwrap().code, 0);
    assert!(
        !f.token.is_cancelled(),
        "dropping an invocation cancelled its task"
    );
    assert!(f.context.has_answer(&url));
    assert_eq!(f.ls_remote(&url).finish().unwrap().code, 0);
    assert!(
        f.challenges.try_recv().is_err(),
        "same task prompted a second time"
    );
    assert_eq!(remote.accepted.load(Ordering::SeqCst), 2);
    assert!(remote.rejected.load(Ordering::SeqCst) >= 2);
    assert!(
        !f.broker.context(None, true).has_answer(&url),
        "answer escaped its task"
    );
    f.assert_private(&[SECRET]);
}

#[test]
fn clone_succeeds_after_helper_challenge_without_remembering_credentials() {
    use gitmanagement_lib::git::sync::{self, CloneReq};

    let remote = HttpRemote::new();
    let f = Fixture::new();
    let url = remote.url();
    f.context.rejected(&url);
    let destination = f._directory.path().join("cloned repo");
    let request = CloneReq {
        url: url.clone(),
        dest: destination.to_str().unwrap().into(),
        branch: None,
        depth: None,
        name: None,
        credential_id: None,
        credential: None,
    };
    let (runner, token) = (f.runner.clone(), f.token.clone());
    let running = Running::start(f.token.clone(), move || {
        sync::clone(&runner, &request, &token, None)
    });
    let challenge = f.challenge(&url);
    f.answer(challenge["id"].as_str().unwrap(), SECRET);
    running.finish().unwrap();
    assert!(destination.join(".git/HEAD").is_file());
    assert_eq!(remote.accepted.load(Ordering::SeqCst), 1);
    assert!(!f.token.is_cancelled());
    f.assert_private(&[SECRET]);
}

#[test]
fn cancelling_the_dialog_stops_git_and_clears_pending_challenges() {
    let remote = HttpRemote::new();
    let f = Fixture::new();
    let url = remote.url();
    f.context.rejected(&url);
    let running = f.ls_remote(&url);
    let challenge = f.challenge(&url);
    f.broker.cancel(challenge["id"].as_str().unwrap());
    assert_eq!(running.finish().unwrap_err().code, "task.cancelled");
    assert!(f.token.is_cancelled());
    assert_eq!(remote.accepted.load(Ordering::SeqCst), 0);
    assert!(f
        .events
        .lock()
        .unwrap()
        .iter()
        .any(|(event, _)| event == "auth-resolved"));
    assert_eq!(
        f.broker
            .respond(AuthResponse {
                id: challenge["id"].as_str().unwrap().into(),
                credential_id: None,
                username: USER.into(),
                secret: SECRET.into(),
                remember: false,
                name: None,
            })
            .unwrap_err()
            .code,
        "credential.expired"
    );
    f.assert_private(&[SECRET]);
}

#[test]
fn cancelling_the_task_interrupts_a_helper_waiting_for_the_dialog() {
    let remote = HttpRemote::new();
    let f = Fixture::new();
    let url = remote.url();
    f.context.rejected(&url);
    let running = f.ls_remote(&url);
    f.challenge(&url);
    f.token.cancel();
    assert_eq!(running.finish().unwrap_err().code, "task.cancelled");
    assert_eq!(remote.accepted.load(Ordering::SeqCst), 0);
    assert!(!f.context.has_answer(&url));
    f.assert_private(&[SECRET]);
}

#[test]
fn bad_initial_credentials_are_erased_then_replaced_before_retry() {
    let remote = HttpRemote::new();
    let f = Fixture::new();
    let url = remote.url();
    let wrong = "wrong-integration-secret";
    f.context
        .set_initial(
            &url,
            None,
            Some(CredentialAnswer {
                username: USER.into(),
                secret: wrong.into(),
                remember: false,
                name: None,
            }),
        )
        .unwrap();
    let error = f.ls_remote(&url).finish().unwrap_err();
    assert_eq!(error.code, "git.authFailed");
    assert!(!error.to_string().contains(wrong));
    assert!(
        !f.context.has_answer(&url),
        "Git's erase did not discard rejected credentials"
    );
    assert!(!f.token.is_cancelled());
    let (context, token, retry_url) = (f.context.clone(), f.token.clone(), url.clone());
    let replacement = Running::start(f.token.clone(), move || {
        context.request_replacement(&retry_url, &token)
    });
    let challenge = f.challenge(&url);
    f.answer(challenge["id"].as_str().unwrap(), SECRET);
    replacement.finish().unwrap();
    assert_eq!(f.ls_remote(&url).finish().unwrap().code, 0);
    assert_eq!(remote.accepted.load(Ordering::SeqCst), 1);
    f.assert_private(&[wrong, SECRET]);
}

#[test]
fn helper_rejects_an_invalid_nonce_without_prompting_or_returning_secrets() {
    let f = Fixture::new();
    let url = "http://127.0.0.1:45678/repo.git";
    f.context
        .set_initial(
            url,
            None,
            Some(CredentialAnswer {
                username: USER.into(),
                secret: SECRET.into(),
                remember: false,
                name: None,
            }),
        )
        .unwrap();
    let invocation =
        Invocation::start(f.context.clone(), f.token.child(), detect_git(None)).unwrap();
    let fields = "protocol=http\nhost=127.0.0.1:45678\npath=repo.git\n\n";
    let mut stream = TcpStream::connect(&invocation.endpoint).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    serde_json::to_writer(
        &mut stream,
        &serde_json::json!({
            "nonce": "unauthorized", "action": "get", "fields": fields,
        }),
    )
    .unwrap();
    stream.write_all(b"\n").unwrap();
    let mut response = String::new();
    // The endpoint closes unauthorized requests; a reset is also a valid refusal.
    if let Err(error) = stream.read_to_string(&mut response) {
        assert!(matches!(
            error.kind(),
            std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::ConnectionAborted
        ));
    }
    assert!(response.is_empty());
    assert!(f.broker.pending().is_empty());
    assert!(f.events.lock().unwrap().is_empty());

    // A rejected connection must not poison the listener. Exercise the actual
    // executable's early helper branch with a valid authenticated request next.
    let mut child = Command::new(env!("CARGO_BIN_EXE_gitmanagement"))
        .args(["--gitmanagement-credential", "get"])
        .env(ENDPOINT_ENV, &invocation.endpoint)
        .env(NONCE_ENV, &invocation.nonce)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(fields.as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    assert_eq!(
        String::from_utf8(output.stdout).unwrap(),
        format!("username={USER}\npassword={SECRET}\n\n")
    );
    assert!(output.stderr.is_empty());
    drop(invocation);
    assert!(!f.token.is_cancelled());
    assert!(credentials::list(&f.db).unwrap().is_empty());
}

#[test]
fn a_new_context_prompts_after_another_task_rejected_the_authority() {
    let remote = HttpRemote::new();
    let f = Fixture::new();
    let url = remote.url();
    f.context.rejected(&url);
    let context = f.broker.context(None, true);
    assert!(!context.has_answer(&url));
    let token = CancelToken::new().with_auth(context.clone());
    let (runner, cwd, request_url, request_token) = (
        f.runner.clone(),
        f._directory.path().to_path_buf(),
        url.clone(),
        token.clone(),
    );
    let running = Running::start(token.clone(), move || {
        runner.run(
            &cwd,
            &[
                "-c",
                "http.proxy=",
                "-c",
                "protocol.version=0",
                "ls-remote",
                &request_url,
            ],
            &RunOpts {
                cancel: Some(request_token),
                ..RunOpts::read()
            },
        )
    });
    let challenge = f.challenge(&url);
    f.answer(challenge["id"].as_str().unwrap(), SECRET);
    assert_eq!(running.finish().unwrap().code, 0);
    assert!(context.has_answer(&url));
    assert!(!f.context.has_answer(&url));
    assert!(!token.is_cancelled());
    assert_eq!(remote.accepted.load(Ordering::SeqCst), 1);
    f.assert_private(&[SECRET]);
}

#[test]
fn failed_remote_delete_preflight_preserves_the_local_branch() {
    use gitmanagement_lib::git::branch::{self, DeleteBranchReq, UpstreamRef};
    use gitmanagement_lib::git::Repo;

    let f = Fixture::new();
    let cwd = f._directory.path();
    let setup = |args: &[&str]| f.runner.run(cwd, args, &RunOpts::default()).unwrap();
    setup(&["init", "-q", "-b", "main"]);
    setup(&[
        "-c",
        "user.name=Integration",
        "-c",
        "user.email=integration@example.com",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--allow-empty",
        "-qm",
        "initial",
    ]);
    setup(&["branch", "keep-local"]);
    let missing_remote = cwd.join("does-not-exist.git");
    setup(&["remote", "add", "origin", missing_remote.to_str().unwrap()]);
    let repo = Repo::new(&f.runner, cwd);
    let error = branch::delete_with_opts(
        &repo,
        &DeleteBranchReq {
            name: "keep-local".into(),
            force: true,
            remote: Some(UpstreamRef {
                remote: "origin".into(),
                branch: "keep-local".into(),
            }),
        },
        &RunOpts {
            cancel: Some(f.token.clone()),
            ..RunOpts::default()
        },
    )
    .unwrap_err();
    assert!(!error.code.is_empty());
    setup(&["show-ref", "--verify", "refs/heads/keep-local"]);
    assert_eq!(setup(&["branch", "--show-current"]).trimmed(), "main");
    let logs = f.runner.log_entries();
    assert!(logs.iter().any(|entry| entry
        .command
        .contains("push --dry-run origin :refs/heads/keep-local")
        && entry.exit_code != Some(0)));
    assert!(!logs
        .iter()
        .any(|entry| entry.command.contains("branch -D keep-local")));
    assert!(f.events.lock().unwrap().is_empty());
}

#[test]
fn secrets_in_git_output_are_scrubbed_from_results_progress_and_log_sinks() {
    let f = Fixture::new();
    f.context
        .set_initial(
            "http://127.0.0.1:45678/repo.git",
            None,
            Some(CredentialAnswer {
                username: USER.into(),
                secret: SECRET.into(),
                remember: false,
                name: None,
            }),
        )
        .unwrap();
    // Rejected answers must remain redacted even after erase removes them from
    // the reusable credential cache.
    f.context.rejected("http://127.0.0.1:45678/repo.git");
    assert!(!f.context.has_answer("http://127.0.0.1:45678/repo.git"));
    let progress = Arc::new(Mutex::new(Vec::<String>::new()));
    let captured_progress = progress.clone();
    let sink = Arc::new(Mutex::new(Vec::<String>::new()));
    let captured_sink = sink.clone();
    f.runner.set_sink(Arc::new(move |entry| {
        captured_sink
            .lock()
            .unwrap()
            .push(serde_json::to_string(entry).unwrap());
    }));
    // Send the secret only over stdin, not command-line arguments or environment.
    let output = f.runner.run(f._directory.path(), &[
        "-c", "alias.echo-secret=!f() { IFS= read -r value; printf '%s\\n' \"$value\"; printf '%s\\n' \"$value\" >&2; }; f", "echo-secret",
    ], &RunOpts {
        stdin: Some(format!("{SECRET}\n").into_bytes()), cancel: Some(f.token.clone()), redact_stdout: true,
        progress: Some(Arc::new(move |_, line| captured_progress.lock().unwrap().push(line.into()))),
        ..RunOpts::default()
    }).unwrap();
    assert_eq!(output.text(), "***\n");
    assert_eq!(output.stderr, "***\n");
    assert_eq!(*progress.lock().unwrap(), vec!["***"]);
    let logs = sink.lock().unwrap();
    assert_eq!(logs.len(), 1);
    assert!(!logs[0].contains(SECRET));
    assert!(logs[0].contains("***"));
    f.assert_private(&[SECRET]);
}
