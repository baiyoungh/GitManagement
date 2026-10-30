use crate::error::{AppError, AppResult};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::{Arc, Condvar, Mutex};

#[derive(Default)]
struct OutputFlow {
    state: Mutex<(usize, bool)>,
    ready: Condvar,
}

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum TerminalEvent {
    Data { data: Vec<u8> },
    Exit { code: u32 },
    Error { message: String },
}

struct Session {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    flow: Arc<OutputFlow>,
}

impl Drop for Session {
    fn drop(&mut self) {
        self.flow.state.lock().unwrap_or_else(|e| e.into_inner()).1 = true;
        self.flow.ready.notify_all();
    }
}

#[derive(Default, Clone)]
pub struct TerminalManager {
    sessions: Arc<Mutex<HashMap<String, Arc<Session>>>>,
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        rows: rows.clamp(2, 500),
        cols: cols.clamp(2, 1000),
        pixel_width: 0,
        pixel_height: 0,
    }
}

fn error(e: impl std::fmt::Display) -> AppError {
    AppError::new("terminal.failed").detail(e.to_string())
}

impl TerminalManager {
    pub fn open(
        &self,
        id: String,
        cwd: &Path,
        cols: u16,
        rows: u16,
        sink: impl Fn(TerminalEvent) -> bool + Send + Sync + 'static,
    ) -> AppResult<()> {
        if uuid::Uuid::parse_str(&id).is_err() {
            return Err(error("Invalid session ID"));
        }
        let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        if sessions.contains_key(&id) || sessions.len() >= 12 {
            return Err(AppError::new("terminal.limit"));
        }
        let pair = native_pty_system()
            .openpty(size(cols, rows))
            .map_err(error)?;
        #[cfg(not(windows))]
        let shell = std::env::var("SHELL")
            .ok()
            .filter(|p| Path::new(p).is_file())
            .unwrap_or_else(|| "/bin/sh".into());
        #[cfg(windows)]
        let shell = std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into());
        let mut command = CommandBuilder::new(shell);
        #[cfg(not(windows))]
        command.arg("-l");
        command.cwd(cwd);
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");
        let mut reader = pair.master.try_clone_reader().map_err(error)?;
        let writer = pair.master.take_writer().map_err(error)?;
        let mut child = pair.slave.spawn_command(command).map_err(error)?;
        drop(pair.slave);
        let flow = Arc::new(OutputFlow::default());
        let session = Arc::new(Session {
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            killer: Mutex::new(child.clone_killer()),
            flow: flow.clone(),
        });
        sessions.insert(id.clone(), session.clone());
        drop(sessions);
        let sink = Arc::new(sink);
        let output = sink.clone();
        let manager = self.clone();
        let reader_id = id.clone();
        let reader_thread = std::thread::spawn(move || {
            let mut buffer = [0; 8192];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(count) => {
                        let mut state = flow.state.lock().unwrap_or_else(|e| e.into_inner());
                        while state.0 >= 128 * 1024 && !state.1 {
                            state = flow.ready.wait(state).unwrap_or_else(|e| e.into_inner());
                        }
                        if state.1 {
                            break;
                        }
                        state.0 += count;
                        drop(state);
                        if !output(TerminalEvent::Data {
                            data: buffer[..count].to_vec(),
                        }) {
                            let _ = manager.close(&reader_id);
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });
        let manager = self.clone();
        std::thread::spawn(move || {
            let event = match child.wait() {
                Ok(status) => TerminalEvent::Exit {
                    code: status.exit_code(),
                },
                Err(e) => TerminalEvent::Error {
                    message: e.to_string(),
                },
            };
            // Drain final output before reporting exit; the renderer acknowledges consumed bytes.
            let _ = reader_thread.join();
            manager
                .sessions
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&id);
            sink(event);
        });
        Ok(())
    }

    fn session(&self, id: &str) -> AppResult<Arc<Session>> {
        self.sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(id)
            .cloned()
            .ok_or_else(|| AppError::new("terminal.closed"))
    }

    pub fn input(&self, id: &str, data: &str) -> AppResult<()> {
        if data.len() > 64 * 1024 {
            return Err(error("Input exceeds 64 KiB"));
        }
        let session = self.session(id)?;
        let mut writer = session.writer.lock().unwrap_or_else(|e| e.into_inner());
        writer.write_all(data.as_bytes()).map_err(error)?;
        writer.flush().map_err(error)
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> AppResult<()> {
        let session = self.session(id)?;
        let result = session
            .master
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .resize(size(cols, rows))
            .map_err(error);
        result
    }

    pub fn ack(&self, id: &str, count: usize) {
        if let Ok(session) = self.session(id) {
            let mut state = session.flow.state.lock().unwrap_or_else(|e| e.into_inner());
            state.0 = state.0.saturating_sub(count);
            session.flow.ready.notify_all();
        }
    }

    pub fn close(&self, id: &str) -> AppResult<()> {
        if let Some(session) = self
            .sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(id)
        {
            session
                .killer
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .kill()
                .map_err(error)?;
        }
        Ok(())
    }

    pub fn close_all(&self) {
        let sessions =
            std::mem::take(&mut *self.sessions.lock().unwrap_or_else(|e| e.into_inner()));
        for session in sessions.into_values() {
            let _ = session
                .killer
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .kill();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    #[test]
    fn real_shell_uses_repo_cwd_accepts_input_and_closes() {
        let root = tempfile::tempdir().unwrap();
        let manager = TerminalManager::default();
        let id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = mpsc::channel();
        manager
            .open(id.clone(), root.path(), 80, 24, move |event| {
                tx.send(event).is_ok()
            })
            .unwrap();
        manager.resize(&id, 110, 30).unwrap();
        #[cfg(windows)]
        {
            // ConPTY inherits the cursor and waits for the terminal's position report.
            let deadline = Instant::now() + Duration::from_secs(15);
            let mut startup = Vec::new();
            while Instant::now() < deadline {
                if let Ok(TerminalEvent::Data { data }) =
                    rx.recv_timeout(Duration::from_millis(100))
                {
                    manager.ack(&id, data.len());
                    startup.extend(data);
                    if startup.windows(4).any(|bytes| bytes == b"\x1b[6n") {
                        manager.input(&id, "\x1b[1;1R").unwrap();
                        break;
                    }
                }
            }
            assert!(
                startup.windows(4).any(|bytes| bytes == b"\x1b[6n"),
                "Missing ConPTY cursor query: {startup:?}"
            );
        }
        #[cfg(not(windows))]
        manager.input(&id, "printf '__GM_CWD__'; pwd\r").unwrap();
        #[cfg(windows)]
        manager.input(&id, "echo __GM_CWD__ & cd\r").unwrap();
        let deadline = Instant::now() + Duration::from_secs(15);
        let expected = root.path().file_name().unwrap().to_string_lossy();
        let mut output = String::new();
        while Instant::now() < deadline {
            if let Ok(TerminalEvent::Data { data }) = rx.recv_timeout(Duration::from_millis(100)) {
                manager.ack(&id, data.len());
                output.push_str(&String::from_utf8_lossy(&data));
                if output.contains("__GM_CWD__") && output.contains(expected.as_ref()) {
                    break;
                }
            }
        }
        assert!(
            output.contains(expected.as_ref()),
            "PTY cwd output: {output}"
        );
        manager.close(&id).unwrap();
        manager.close(&id).unwrap();
        assert_eq!(manager.input(&id, "x").unwrap_err().code, "terminal.closed");
        let mut exited = false;
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if let Ok(TerminalEvent::Exit { .. }) = rx.recv_timeout(Duration::from_millis(100)) {
                exited = true;
                break;
            }
        }
        assert!(exited, "Shell did not exit after closing the session");
    }

    #[cfg(unix)]
    #[test]
    fn drains_large_output_with_acknowledgements_before_exit() {
        let root = tempfile::tempdir().unwrap();
        let manager = TerminalManager::default();
        let id = uuid::Uuid::new_v4().to_string();
        let ack_manager = manager.clone();
        let ack_id = id.clone();
        let (tx, rx) = mpsc::channel();
        manager
            .open(id.clone(), root.path(), 80, 24, move |event| {
                if let TerminalEvent::Data { ref data } = event {
                    ack_manager.ack(&ack_id, data.len());
                }
                tx.send(event).is_ok()
            })
            .unwrap();
        manager
            .input(
                &id,
                "head -c 262144 /dev/zero | tr '\\000' x; printf __DRAINED__; exit\r",
            )
            .unwrap();
        let mut data = Vec::new();
        let mut exited = false;
        let deadline = Instant::now() + Duration::from_secs(15);
        while Instant::now() < deadline {
            match rx.recv_timeout(Duration::from_millis(100)) {
                Ok(TerminalEvent::Data { data: chunk }) => data.extend(chunk),
                Ok(TerminalEvent::Exit { .. }) => {
                    exited = true;
                    break;
                }
                _ => {}
            }
        }
        manager.close_all();
        assert!(exited, "Large output did not drain before exit");
        assert!(data.iter().filter(|&&b| b == b'x').count() >= 262144);
        assert!(String::from_utf8_lossy(&data).contains("__DRAINED__"));
    }
}
