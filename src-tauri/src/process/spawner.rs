// process/spawner.rs
//
// TauriAgentSpawner — the production `AgentSpawner`. It launches the agent
// layer as a managed `node` subprocess via tauri-plugin-shell (ADR-002),
// passing the session/project/task as CLI arguments to the agent entrypoint
// (`agents/dist/sidecar.js`), and attaches the storage bridge to it (ADR-009).
//
// For each spawned process a background task consumes its event stream:
//
//   - every stdout line goes to the session's `BridgeHost`; a request is
//     serviced against the project's stores and its response written back to
//     the process's stdin, which is how the running agent reaches Rust-owned
//     memory, audit, and reference resolution
//   - a `failed` status line's error is remembered as the failure reason
//   - termination is reported to `commands::agent::record_agent_exit`, which
//     updates the session status and records the lifecycle audit event
//
// This file is deliberately only the forwarding loop. It needs a real Tauri
// `AppHandle` and async runtime, so it is not unit-tested; the logic it calls
// is: `BridgeHost` (bridge/host.rs, plus the cross-process test in
// tests/storage_bridge.rs), the manager's state machine (manager.rs), and
// `record_agent_exit` (commands/agent.rs). A real end-to-end launch is the
// live integration check.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

use super::manager::{AgentHandle, AgentSpawnSpec, AgentSpawner};
use crate::bridge::{BridgeHost, LineOutcome};
use crate::commands::agent::{record_agent_exit, ManagerState};
use crate::commands::project::RegistryState;

/// The spawned process, shared between the handle that kills it and the bridge
/// task that writes responses to its stdin. `None` once it has been killed or
/// has exited.
type SharedChild = Arc<Mutex<Option<CommandChild>>>;

/// Status reported by the sidecar when the agent run ends in an error.
const STATUS_FAILED: &str = "failed";

/// Spawns agent processes as `node <entry> …` through the Tauri shell plugin.
pub struct TauriAgentSpawner {
    app: AppHandle,
    /// Path to the compiled agent entrypoint script (`agents/dist/sidecar.js`).
    entry: PathBuf,
    /// System-default standards directory, the base tier for `standards://`.
    standards_root: PathBuf,
}

impl TauriAgentSpawner {
    pub fn new(app: AppHandle, entry: PathBuf, standards_root: PathBuf) -> Self {
        Self {
            app,
            entry,
            standards_root,
        }
    }
}

impl AgentSpawner for TauriAgentSpawner {
    fn spawn(&self, spec: &AgentSpawnSpec<'_>) -> Result<Box<dyn AgentHandle>, String> {
        let (mut events, child) = self
            .app
            .shell()
            .command("node")
            .args([
                self.entry.to_string_lossy().to_string(),
                "--session".to_string(),
                spec.session_id.to_string(),
                "--project".to_string(),
                spec.project_id.to_string(),
                "--project-path".to_string(),
                spec.project_path.to_string_lossy().to_string(),
                "--agent-type".to_string(),
                spec.agent_type.to_string(),
                "--task".to_string(),
                spec.task.to_string(),
            ])
            .spawn()
            .map_err(|e| format!("failed to spawn agent process: {e}"))?;

        let host = BridgeHost::new(
            spec.session_id,
            spec.project_id,
            spec.project_path,
            &self.standards_root,
        );
        let child: SharedChild = Arc::new(Mutex::new(Some(child)));
        let bridge_child = Arc::clone(&child);
        let app = self.app.clone();
        let session_id = spec.session_id.to_string();

        // Consume the event stream for the life of the process. Draining it
        // also keeps a full stdout pipe from ever blocking the child. Requests
        // are serviced inline and in order; each is a short local store call.
        tauri::async_runtime::spawn(async move {
            let mut failure_reason: Option<String> = None;

            while let Some(event) = events.recv().await {
                match event {
                    CommandEvent::Stdout(bytes) => {
                        match host.handle_line(&String::from_utf8_lossy(&bytes)) {
                            LineOutcome::Response(response) => {
                                write_line(&bridge_child, &response);
                            }
                            LineOutcome::Status(status) if status.status == STATUS_FAILED => {
                                failure_reason = status.error;
                            }
                            LineOutcome::Status(_) | LineOutcome::Ignored => {}
                        }
                    }
                    CommandEvent::Terminated(payload) => {
                        // The process is gone: release the handle so a later
                        // stop has nothing to kill, then record the exit.
                        if let Ok(mut guard) = bridge_child.lock() {
                            guard.take();
                        }
                        if let Err(e) = record_agent_exit(
                            app.state::<RegistryState>().inner(),
                            app.state::<ManagerState>().inner(),
                            &session_id,
                            payload.code,
                            failure_reason.take(),
                        ) {
                            eprintln!("agent {session_id}: failed to record process exit: {e}");
                        }
                        break;
                    }
                    // Stderr carries the agent layer's diagnostics; they are
                    // not part of the protocol.
                    _ => {}
                }
            }
        });

        Ok(Box::new(TauriAgentHandle { child }))
    }
}

/// Writes one response line to the process's stdin. A failure means the
/// process is exiting or already gone; its in-flight requests die with it, so
/// the error is reported and otherwise ignored.
fn write_line(child: &SharedChild, line: &str) {
    let Ok(mut guard) = child.lock() else {
        return;
    };
    if let Some(child) = guard.as_mut() {
        if let Err(e) = child.write(format!("{line}\n").as_bytes()) {
            eprintln!("storage bridge: failed to write a response to the agent process: {e}");
        }
    }
}

/// Handle to a spawned process. `kill` consumes the underlying `CommandChild`
/// (ADR-002); if the process already exited there is nothing left to kill.
struct TauriAgentHandle {
    child: SharedChild,
}

impl AgentHandle for TauriAgentHandle {
    fn kill(self: Box<Self>) -> Result<(), String> {
        let child = self
            .child
            .lock()
            .map_err(|e| format!("agent process handle is poisoned: {e}"))?
            .take();
        match child {
            Some(child) => child
                .kill()
                .map_err(|e| format!("failed to kill agent process: {e}")),
            None => Ok(()),
        }
    }
}
