//! Real OpenSSH + the application's SSH wrapper/askpass, on loopback only.
//! Every key, config, repository and known_hosts file is disposable. No process-
//! global environment changes, ssh-agent, OS keychain, root, or external network.
//! sshd-dependent cases explicitly print SKIP when a local daemon cannot run;
//! helper IPC and `ssh -G` cases still exercise real executables independently.
use gitmanagement_lib::auth::{
    AuthBroker, AuthContext, AuthResponse, Invocation, ENDPOINT_ENV, NONCE_ENV,
};
use gitmanagement_lib::credentials;
use gitmanagement_lib::error::AppResult;
use gitmanagement_lib::git::runner::{detect_git, CancelToken, GitOutput, GitRunner, RunOpts};
use gitmanagement_lib::storage::Db;
use serde_json::Value;
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

const TIMEOUT: Duration = Duration::from_secs(15);
const PHRASE: &str = "loopback-encrypted-key-73";
const PASSWORD: &str = "ipc-only-password-91";
const ALIAS: &str = "gitmanagement-loopback";
const DESTINATION_ENV: &str = "GITMANAGEMENT_SSH_DESTINATION";

/// Kill descendants too: sshd and the SSH wrapper may each have children.
struct Process(Option<Child>);
impl Process {
    fn spawn(command: &mut Command) -> Self {
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        Self(Some(command.spawn().expect("spawn test subprocess")))
    }

    fn output(mut self) -> Output {
        let deadline = Instant::now() + TIMEOUT;
        loop {
            if self.0.as_mut().unwrap().try_wait().unwrap().is_some() {
                return self.0.take().unwrap().wait_with_output().unwrap();
            }
            assert!(Instant::now() < deadline, "test subprocess timed out");
            thread::sleep(Duration::from_millis(10));
        }
    }
}
impl Drop for Process {
    fn drop(&mut self) {
        if let Some(mut child) = self.0.take() {
            #[cfg(unix)]
            {
                extern "C" {
                    fn kill(pid: i32, sig: i32) -> i32;
                }
                // Every child starts its own group, never the test runner's.
                unsafe {
                    kill(-(child.id() as i32), 9);
                }
            }
            #[cfg(windows)]
            if let Some(root) = std::env::var_os("SystemRoot") {
                let _ = Command::new(PathBuf::from(root).join("System32/taskkill.exe"))
                    .args(["/PID", &child.id().to_string(), "/T", "/F"])
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status();
            }
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn output(command: &mut Command) -> Output {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    Process::spawn(command).output()
}

fn checked(command: &mut Command) -> Output {
    let out = output(command);
    assert!(
        out.status.success(),
        "fixture command failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    out
}

struct Fixture {
    directory: Arc<tempfile::TempDir>,
    db: Arc<Db>,
    broker: Arc<AuthBroker>,
    context: Arc<AuthContext>,
    token: CancelToken,
    events: Arc<Mutex<Vec<(String, Value)>>>,
    challenges: mpsc::Receiver<Value>,
}
impl Fixture {
    fn new(interactive: bool) -> Self {
        let directory = Arc::new(tempfile::tempdir().unwrap());
        let db = Arc::new(Db::open_in_memory().unwrap());
        let events = Arc::new(Mutex::new(Vec::new()));
        let captured = events.clone();
        let (send, challenges) = mpsc::channel();
        let broker = AuthBroker::new(
            db.clone(),
            Arc::new(move |event, value| {
                captured.lock().unwrap().push((event.into(), value.clone()));
                if event == "auth-challenge" {
                    let _ = send.send(value);
                }
            }),
        );
        let context = broker.context(Some("ssh-integration-task".into()), interactive);
        let token = CancelToken::new().with_auth(context.clone());
        Self {
            directory,
            db,
            broker,
            context,
            token,
            events,
            challenges,
        }
    }

    fn invocation(&self) -> Invocation {
        Invocation::start(self.context.clone(), self.token.child(), detect_git(None)).unwrap()
    }

    fn askpass(&self, invocation: &Invocation, prompt: &str, destination: &str) -> Process {
        let mut command = Command::new(env!("CARGO_BIN_EXE_gitmanagement"));
        command
            .arg(prompt)
            .env("GITMANAGEMENT_SSH_ASKPASS", "1")
            .env(ENDPOINT_ENV, &invocation.endpoint)
            .env(NONCE_ENV, &invocation.nonce)
            .env(DESTINATION_ENV, destination)
            .env_remove("GITMANAGEMENT_ASKPASS")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        Process::spawn(&mut command)
    }

    fn challenge(&self, kind: &str) -> Value {
        let value = self
            .challenges
            .recv_timeout(TIMEOUT)
            .expect("SSH challenge not emitted");
        assert_eq!(value["kind"], kind);
        assert_eq!(value["taskId"], "ssh-integration-task");
        assert!(value["profiles"].as_array().unwrap().is_empty());
        assert!(value["ssh"].is_object(), "missing SSH metadata: {value}");
        value
    }

    fn answer(&self, challenge: &Value, secret: &str) {
        self.broker
            .respond(AuthResponse {
                id: challenge["id"].as_str().unwrap().into(),
                credential_id: None,
                username: String::new(),
                secret: secret.into(),
                remember: false,
                name: None,
            })
            .unwrap();
    }

    fn runner(&self, config: &Path) -> Arc<GitRunner> {
        let mut runner = GitRunner::new(detect_git(None));
        runner.set_askpass_path(PathBuf::from(env!("CARGO_BIN_EXE_gitmanagement")));
        runner.set_ssh_config(config.to_path_buf());
        Arc::new(runner)
    }

    fn ls_remote(&self, runner: Arc<GitRunner>, remote: &Remote) -> Running {
        let (directory, token, url) = (self.directory.clone(), self.token.clone(), remote.url());
        let (send, result) = mpsc::channel();
        let worker = thread::spawn(move || {
            let _ = send.send(runner.run(
                directory.path(),
                &["ls-remote", &url],
                &RunOpts {
                    cancel: Some(token),
                    ..RunOpts::read()
                },
            ));
        });
        Running {
            token: self.token.clone(),
            result,
            worker: Some(worker),
        }
    }

    fn assert_private(&self, runner: Option<&GitRunner>) {
        assert!(self.broker.pending().is_empty());
        assert!(
            credentials::list(&self.db).unwrap().is_empty(),
            "SSH secret persisted a profile"
        );
        let events = serde_json::to_string(&*self.events.lock().unwrap()).unwrap();
        let logs = runner
            .map(|r| serde_json::to_string(&r.log_entries()).unwrap())
            .unwrap_or_default();
        for secret in [PHRASE, PASSWORD] {
            assert!(!events.contains(secret), "secret leaked to event");
            assert!(!logs.contains(secret), "secret leaked to command log");
        }
    }

    fn assert_no_challenge(&self) {
        assert!(
            self.challenges.try_recv().is_err(),
            "unexpected SSH trust/credential dialog"
        );
    }
}

struct Running {
    token: CancelToken,
    result: mpsc::Receiver<AppResult<GitOutput>>,
    worker: Option<JoinHandle<()>>,
}
impl Running {
    fn finish(mut self) -> AppResult<GitOutput> {
        let result = self
            .result
            .recv_timeout(TIMEOUT)
            .expect("Git SSH operation timed out");
        self.worker.take().unwrap().join().unwrap();
        result
    }
}
impl Drop for Running {
    fn drop(&mut self) {
        if let Some(worker) = self.worker.take() {
            self.token.cancel();
            // Bounded even on a regression in the runner's cancellation path.
            let _ = self.result.recv_timeout(Duration::from_secs(3));
            if worker.is_finished() {
                let _ = worker.join();
            }
        }
    }
}

fn null_device() -> &'static str {
    if cfg!(windows) {
        "NUL"
    } else {
        "/dev/null"
    }
}
fn quoted(path: &Path) -> String {
    format!(
        "\"{}\"",
        path.to_string_lossy()
            .replace('\\', "/")
            .replace('"', "\\\"")
    )
}

/// Config also tested with real `ssh -G`, independently of sshd availability.
fn write_client_config(directory: &Path, port: u16, username: &str) -> PathBuf {
    let config = directory.join("isolated ssh config");
    fs::write(
        &config,
        format!(
            "Host {ALIAS}\n  HostName 127.0.0.1\n  Port {port}\n  User {username}\n\
         Host *\n  IdentityFile {}\n  IdentitiesOnly yes\n  IdentityAgent none\n\
           UserKnownHostsFile {}\n  GlobalKnownHostsFile {}\n  StrictHostKeyChecking ask\n\
           PreferredAuthentications publickey\n  PasswordAuthentication no\n\
           KbdInteractiveAuthentication no\n  NumberOfPasswordPrompts 1\n\
           ConnectTimeout 3\n  ConnectionAttempts 1\n  UpdateHostKeys no\n  AddKeysToAgent no\n\
           ProxyCommand none\n  ProxyJump none\n  ControlMaster no\n  ControlPath none\n",
            quoted(&directory.join("encrypted identity")),
            quoted(&directory.join("known hosts")),
            null_device()
        ),
    )
    .unwrap();
    config
}

struct Remote {
    // Stop sshd before removing its keys/config/logs.
    _daemon: Process,
    config: PathBuf,
    known_hosts: PathBuf,
    identity: PathBuf,
    repository: PathBuf,
    host_public: PathBuf,
    fingerprint: String,
    port: u16,
}
impl Remote {
    fn start(f: &Fixture) -> Option<Self> {
        let directory = f.directory.path();
        let sshd = if cfg!(unix) {
            PathBuf::from("/usr/sbin/sshd")
        } else {
            PathBuf::from("sshd")
        };
        for (program, arg) in [(PathBuf::from("ssh"), "-V"), (sshd.clone(), "-V")] {
            match Command::new(&program)
                .arg(arg)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
            {
                Ok(child) => {
                    let _ = Process(Some(child)).output();
                }
                Err(error) => {
                    eprintln!(
                        "SKIP real loopback sshd: {} unavailable: {error}",
                        program.display()
                    );
                    return None;
                }
            }
        }
        // This suite never creates a login account and never permits root login.
        let out = output(
            Command::new(if cfg!(windows) { "whoami" } else { "id" }).args(if cfg!(windows) {
                vec![]
            } else {
                vec!["-un"]
            }),
        );
        assert!(out.status.success());
        let username = String::from_utf8(out.stdout).unwrap().trim().to_owned();
        if username == "root" || username.contains(['\\', '\n', '\r', ' ']) {
            eprintln!("SKIP real loopback sshd: requires an existing non-root local login account");
            return None;
        }
        let identity = directory.join("encrypted identity");
        checked(
            Command::new("ssh-keygen")
                .args(["-q", "-t", "ed25519", "-a", "1", "-N", PHRASE, "-f"])
                .arg(&identity),
        );
        let host = directory.join("host_key");
        checked(
            Command::new("ssh-keygen")
                .args(["-q", "-t", "ed25519", "-N", "", "-f"])
                .arg(&host),
        );
        let host_public = directory.join("host_key.pub");
        let fingerprint = String::from_utf8(
            checked(Command::new("ssh-keygen").arg("-lf").arg(&host_public)).stdout,
        )
        .unwrap()
        .split_whitespace()
        .nth(1)
        .unwrap()
        .to_owned();
        let authorized = directory.join("authorized_keys");
        fs::copy(directory.join("encrypted identity.pub"), &authorized).unwrap();
        let repository = directory.join("remote repo.git");
        checked(
            Command::new(detect_git(None))
                .args(["init", "--bare", "--quiet"])
                .arg(&repository)
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env("GIT_CONFIG_GLOBAL", null_device()),
        );
        let reservation = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = reservation.local_addr().unwrap().port();
        let config = write_client_config(directory, port, &username);
        let server_config = directory.join("sshd_config");
        fs::write(
            &server_config,
            format!(
                "ListenAddress 127.0.0.1\nPort {port}\nHostKey {}\nPidFile {}\n\
             AuthorizedKeysFile {}\nStrictModes no\nUsePAM no\nPubkeyAuthentication yes\n\
             PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin no\n\
             AllowUsers {username}\nAllowTcpForwarding no\nX11Forwarding no\nPermitTunnel no\n\
             PermitUserEnvironment no\nUseDNS no\nLogLevel VERBOSE\nLoginGraceTime 10\n",
                quoted(&host),
                quoted(&directory.join("sshd.pid")),
                quoted(&authorized)
            ),
        )
        .unwrap();
        let log = directory.join("sshd.log");
        let log_file = fs::File::create(&log).unwrap();
        drop(reservation);
        let mut daemon = Process::spawn(
            Command::new(sshd)
                .args(["-D", "-e", "-f"])
                .arg(&server_config)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::from(log_file)),
        );
        let deadline = Instant::now() + Duration::from_secs(4);
        loop {
            if let Some(status) = daemon.0.as_mut().unwrap().try_wait().unwrap() {
                eprintln!("SKIP real loopback sshd: daemon cannot start without elevated/system setup ({status}): {}", fs::read_to_string(&log).unwrap());
                return None;
            }
            if TcpStream::connect(("127.0.0.1", port)).is_ok() {
                break;
            }
            if Instant::now() >= deadline {
                eprintln!(
                    "SKIP real loopback sshd: no loopback listener: {}",
                    fs::read_to_string(&log).unwrap()
                );
                return None;
            }
            thread::sleep(Duration::from_millis(20));
        }
        Some(Self {
            _daemon: daemon,
            config,
            known_hosts: directory.join("known hosts"),
            identity,
            repository,
            host_public,
            fingerprint,
            port,
        })
    }

    fn url(&self) -> String {
        format!("{ALIAS}:{}", self.repository.display())
    }

    fn trust(&self) {
        let public = fs::read_to_string(&self.host_public).unwrap();
        fs::write(
            &self.known_hosts,
            format!("[127.0.0.1]:{} {public}", self.port),
        )
        .unwrap();
    }

    fn replace_known_key(&self, directory: &Path) {
        let stale = directory.join("stale_host_key");
        checked(
            Command::new("ssh-keygen")
                .args(["-q", "-t", "ed25519", "-N", "", "-f"])
                .arg(&stale),
        );
        let public = fs::read_to_string(directory.join("stale_host_key.pub")).unwrap();
        fs::write(
            &self.known_hosts,
            format!("[127.0.0.1]:{} {public}", self.port),
        )
        .unwrap();
    }
}

#[test]
fn real_ssh_config_is_isolated_from_user_keys_agents_and_known_hosts() {
    let f = Fixture::new(true);
    let config = write_client_config(f.directory.path(), 43210, "fixture-user");
    let out = match Command::new("ssh").arg("-V").output() {
        Ok(_) => checked(
            Command::new("ssh")
                .arg("-F")
                .arg(&config)
                .args(["-G", ALIAS]),
        ),
        Err(error) => {
            eprintln!("SKIP real ssh -G: OpenSSH unavailable: {error}");
            return;
        }
    };
    let text = String::from_utf8(out.stdout).unwrap();
    for expected in [
        "hostname 127.0.0.1",
        "port 43210",
        "user fixture-user",
        "identitiesonly yes",
        "identityagent none",
        "stricthostkeychecking ask",
        "passwordauthentication no",
    ] {
        assert!(
            text.lines().any(|line| line == expected),
            "ssh -G missing {expected}: {text}"
        );
    }
    let identities: Vec<_> = text
        .lines()
        .filter(|line| line.starts_with("identityfile "))
        .collect();
    assert_eq!(identities.len(), 1, "default user identities were included");
    assert!(identities[0].contains("encrypted identity"));
    assert!(text
        .lines()
        .find(|line| line.starts_with("userknownhostsfile "))
        .unwrap()
        .contains("known hosts"));
    assert!(text
        .lines()
        .any(|line| line == format!("globalknownhostsfile {}", null_device())));
}

#[test]
fn real_sshd_prompts_for_host_fingerprint_then_encrypted_key_and_runs_git() {
    // The IPC round trip remains covered even on hosts where sshd cannot run.
    let ipc = Fixture::new(true);
    let invocation = ipc.invocation();
    let fingerprint = "SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
    let prompt = format!("The authenticity of host '[127.0.0.1]:40222 ([127.0.0.1]:40222)' can't be established.\nED25519 key fingerprint is {fingerprint}.\nAre you sure you want to continue connecting (yes/no/[fingerprint])? ");
    let helper = ipc.askpass(&invocation, &prompt, "fixture-user@127.0.0.1");
    let challenge = ipc.challenge("sshHostKey");
    assert_eq!(challenge["ssh"]["fingerprint"], fingerprint);
    assert_eq!(challenge["ssh"]["host"], "127.0.0.1");
    assert_eq!(challenge["ssh"]["port"], 40222);
    assert_eq!(challenge["ssh"]["keyType"], "ED25519");
    ipc.answer(&challenge, "yes");
    let out = helper.output();
    assert!(out.status.success());
    assert_eq!(out.stdout, b"yes\n");
    ipc.assert_private(None);
    drop(invocation);

    let f = Fixture::new(true);
    let Some(remote) = Remote::start(&f) else {
        return;
    };
    let runner = f.runner(&remote.config);
    let running = f.ls_remote(runner.clone(), &remote);
    let host = f.challenge("sshHostKey");
    assert_eq!(host["ssh"]["fingerprint"], remote.fingerprint);
    assert_eq!(host["ssh"]["host"], "127.0.0.1");
    assert_eq!(host["ssh"]["port"], remote.port);
    assert!(host["ssh"]["keyType"]
        .as_str()
        .unwrap()
        .eq_ignore_ascii_case("ed25519"));
    f.answer(&host, "yes");
    let passphrase = f.challenge("sshPassphrase");
    assert_eq!(
        passphrase["ssh"]["keyPath"],
        remote.identity.to_string_lossy().as_ref()
    );
    f.answer(&passphrase, PHRASE);
    assert_eq!(running.finish().unwrap().code, 0);
    assert!(!f.token.is_cancelled());
    assert!(fs::read_to_string(&remote.known_hosts)
        .unwrap()
        .contains("ssh-ed25519"));
    f.assert_no_challenge();
    f.assert_private(Some(&runner));
}

#[test]
fn real_sshd_changed_host_key_is_rejected_without_a_trust_dialog() {
    let f = Fixture::new(true);
    let Some(remote) = Remote::start(&f) else {
        return;
    };
    remote.replace_known_key(f.directory.path());
    let before = fs::read(&remote.known_hosts).unwrap();
    let runner = f.runner(&remote.config);
    let error = f.ls_remote(runner.clone(), &remote).finish().unwrap_err();
    assert_eq!(error.code, "ssh.hostKeyChanged");
    assert_eq!(fs::read(&remote.known_hosts).unwrap(), before);
    assert!(!f.token.is_cancelled());
    f.assert_no_challenge();
    f.assert_private(Some(&runner));
}

#[test]
fn real_sshd_cancelling_host_trust_stops_git_without_recording_trust() {
    let ipc = Fixture::new(true);
    let invocation = ipc.invocation();
    let helper = ipc.askpass(
        &invocation,
        "fixture-user@127.0.0.1's password: ",
        "fixture-user@127.0.0.1",
    );
    let challenge = ipc.challenge("sshPassword");
    ipc.broker.cancel(challenge["id"].as_str().unwrap());
    let out = helper.output();
    assert!(!out.status.success());
    assert!(out.stdout.is_empty());
    assert!(ipc.token.is_cancelled());
    ipc.assert_private(None);
    drop(invocation);

    let f = Fixture::new(true);
    let Some(remote) = Remote::start(&f) else {
        return;
    };
    let runner = f.runner(&remote.config);
    let running = f.ls_remote(runner.clone(), &remote);
    let challenge = f.challenge("sshHostKey");
    f.broker.cancel(challenge["id"].as_str().unwrap());
    assert_eq!(running.finish().unwrap_err().code, "task.cancelled");
    assert!(f.token.is_cancelled());
    assert!(!remote.known_hosts.exists() || fs::read(&remote.known_hosts).unwrap().is_empty());
    f.assert_no_challenge();
    f.assert_private(Some(&runner));
}

#[test]
fn real_sshd_task_cancel_interrupts_encrypted_key_dialog_and_cleans_pending() {
    let f = Fixture::new(true);
    let Some(remote) = Remote::start(&f) else {
        return;
    };
    remote.trust();
    let runner = f.runner(&remote.config);
    let running = f.ls_remote(runner.clone(), &remote);
    f.challenge("sshPassphrase");
    f.token.cancel();
    assert_eq!(running.finish().unwrap_err().code, "task.cancelled");
    f.assert_no_challenge();
    f.assert_private(Some(&runner));
}

#[test]
fn silent_context_never_opens_password_or_real_sshd_dialogs() {
    let f = Fixture::new(false);
    let invocation = f.invocation();
    let out = f
        .askpass(
            &invocation,
            "fixture-user@127.0.0.1's password: ",
            "fixture-user@127.0.0.1",
        )
        .output();
    assert!(!out.status.success());
    assert!(out.stdout.is_empty());
    f.assert_no_challenge();
    drop(invocation);
    let Some(remote) = Remote::start(&f) else {
        f.assert_private(None);
        return;
    };
    let runner = f.runner(&remote.config);
    assert!(f.ls_remote(runner.clone(), &remote).finish().is_err());
    f.assert_no_challenge();
    assert!(!f.token.is_cancelled());
    assert!(!remote.known_hosts.exists() || fs::read(&remote.known_hosts).unwrap().is_empty());
    // With trust pre-seeded, BatchMode must still refuse an encrypted identity
    // without opening the passphrase dialog or falling back to an agent.
    remote.trust();
    assert!(f.ls_remote(runner.clone(), &remote).finish().is_err());
    f.assert_no_challenge();
    f.assert_private(Some(&runner));
}

#[test]
fn password_askpass_binary_uses_authenticated_ipc_and_ipv6_destination_metadata() {
    let f = Fixture::new(true);
    let invocation = f.invocation();
    let destination = "ssh://fixture-user@[::1]:40222";
    let helper = f.askpass(&invocation, "fixture-user@::1's password: ", destination);
    let challenge = f.challenge("sshPassword");
    assert_eq!(challenge["ssh"]["host"], "::1");
    assert_eq!(challenge["ssh"]["port"], 40222);
    assert_eq!(challenge["ssh"]["username"], "fixture-user");
    assert_eq!(challenge["ssh"]["destination"], destination);
    f.answer(&challenge, PASSWORD);
    let out = helper.output();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(out.stdout, format!("{PASSWORD}\n").as_bytes());
    assert!(out.stderr.is_empty());
    assert!(!f.token.is_cancelled());
    f.assert_private(None);
}

#[test]
fn passphrase_askpass_binary_parses_quoted_key_path_without_persisting_secret() {
    let f = Fixture::new(true);
    let invocation = f.invocation();
    let key = f.directory.path().join("key with spaces");
    let helper = f.askpass(
        &invocation,
        &format!("Enter passphrase for key '{}': ", key.display()),
        "fixture-user@127.0.0.1",
    );
    let challenge = f.challenge("sshPassphrase");
    assert_eq!(challenge["ssh"]["keyPath"], key.to_string_lossy().as_ref());
    f.answer(&challenge, PHRASE);
    let out = helper.output();
    assert!(out.status.success());
    assert_eq!(out.stdout, format!("{PHRASE}\n").as_bytes());
    assert!(out.stderr.is_empty());
    f.assert_private(None);
}

#[test]
fn short_ssh_password_does_not_corrupt_machine_readable_git_output() {
    let f = Fixture::new(true);
    let invocation = f.invocation();
    let helper = f.askpass(&invocation, "fixture-user@host's password: ", "fixture-user@host");
    let challenge = f.challenge("sshPassword");
    f.answer(&challenge, "a");
    assert!(helper.output().status.success());
    drop(invocation);
    let mut runner = GitRunner::new(detect_git(None));
    runner.set_askpass_path(PathBuf::from(env!("CARGO_BIN_EXE_gitmanagement")));
    let out = runner.run(f.directory.path(), &["version"], &RunOpts { cancel: Some(f.token.clone()), ..RunOpts::read() }).unwrap();
    assert!(out.text().starts_with("git version"));
    let out = runner.run(f.directory.path(), &["-c", "alias.fixture-output=!printf 'a-ref-name\\n'", "fixture-output"],
        &RunOpts { cancel: Some(f.token.clone()), ..RunOpts::read() }).unwrap();
    assert_eq!(out.text(), "a-ref-name\n");
}

#[test]
fn unknown_askpass_prompts_fail_closed_without_a_dialog_or_secret() {
    let f = Fixture::new(true);
    let invocation = f.invocation();
    let out = f
        .askpass(
            &invocation,
            "Enter verification code: ",
            "fixture-user@127.0.0.1",
        )
        .output();
    assert!(!out.status.success());
    assert!(out.stdout.is_empty());
    f.assert_no_challenge();
    f.assert_private(None);
}

#[test]
fn ssh_askpass_ipc_rejects_invalid_nonce_then_accepts_real_helper() {
    let f = Fixture::new(true);
    let invocation = f.invocation();
    let mut stream = TcpStream::connect(&invocation.endpoint).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    serde_json::to_writer(&mut stream, &serde_json::json!({
        "nonce": "wrong-nonce", "action": "ssh-askpass",
        "fields": serde_json::json!({"prompt": "fixture-user@127.0.0.1's password: ", "destination": "fixture-user@127.0.0.1"}).to_string()
    })).unwrap();
    stream.write_all(b"\n").unwrap();
    let mut response = String::new();
    if let Err(error) = stream.read_to_string(&mut response) {
        assert!(matches!(
            error.kind(),
            std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::ConnectionAborted
        ));
    }
    assert!(response.is_empty());
    f.assert_no_challenge();
    assert!(f.events.lock().unwrap().is_empty());
    let helper = f.askpass(
        &invocation,
        "fixture-user@127.0.0.1's password: ",
        "fixture-user@127.0.0.1",
    );
    let challenge = f.challenge("sshPassword");
    f.answer(&challenge, PASSWORD);
    let out = helper.output();
    assert!(out.status.success());
    assert_eq!(out.stdout, format!("{PASSWORD}\n").as_bytes());
    f.assert_private(None);
}
