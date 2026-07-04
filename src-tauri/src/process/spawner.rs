// process/spawner.rs
//
// TauriAgentSpawner — the production `AgentSpawner`. It launches the agent
// layer as a managed `node` subprocess via tauri-plugin-shell (ADR-002),
// passing the session/project/task as CLI arguments to the agent entrypoint
// (`agents/dist/sidecar.js`).
//
// This spawner needs a real Tauri `AppHandle` and async runtime, so it is not
// unit-tested here — the manager's lifecycle is covered with a stub spawner in
// manager.rs, and a real end-to-end launch is the #11 live integration check.
//
// The launched process cannot yet reach Rust-owned memory/audit stores (a Node
// subprocess cannot call Tauri `invoke`); wiring those through a Node↔Rust
// storage bridge is a tracked follow-up.

use std::path::PathBuf;

use tauri::AppHandle;
use tauri_plugin_shell::ShellExt;

use super::manager::{AgentHandle, AgentSpawnSpec, AgentSpawner};

/// Spawns agent processes as `node <entry> …` through the Tauri shell plugin.
pub struct TauriAgentSpawner {
    app: AppHandle,
    /// Path to the compiled agent entrypoint script (`agents/dist/sidecar.js`).
    entry: PathBuf,
}

impl TauriAgentSpawner {
    pub fn new(app: AppHandle, entry: PathBuf) -> Self {
        Self { app, entry }
    }
}

impl AgentSpawner for TauriAgentSpawner {
    fn spawn(&self, spec: &AgentSpawnSpec<'_>) -> Result<Box<dyn AgentHandle>, String> {
        let (mut rx, child) = self
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

        // Drain the process event stream in the background so a full stdout
        // pipe never blocks the child. Forwarding these events to the audit
        // trail and the frontend is the storage-bridge follow-up; for now they
        // are consumed and discarded.
        tauri::async_runtime::spawn(async move { while rx.recv().await.is_some() {} });

        Ok(Box::new(TauriAgentHandle { child }))
    }
}

/// Handle wrapping a spawned `CommandChild`. `kill` consumes it (ADR-002).
struct TauriAgentHandle {
    child: tauri_plugin_shell::process::CommandChild,
}

impl AgentHandle for TauriAgentHandle {
    fn kill(self: Box<Self>) -> Result<(), String> {
        self.child
            .kill()
            .map_err(|e| format!("failed to kill agent process: {e}"))
    }
}
