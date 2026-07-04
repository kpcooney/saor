// process/manager.rs
//
// AgentProcessManager — owns the lifecycle of running agent processes: start
// (spawn + track), status (query), and stop (kill + mark stopped). In Phase 1
// this manages a single Code Agent at a time; the same interface extends to
// concurrent agents in Phase 2.
//
// Spawning is abstracted behind the `AgentSpawner` trait so the lifecycle can
// be tested deterministically with a stub (no real process), while production
// uses `TauriAgentSpawner`, which launches `node <agent-entry>` via
// tauri-plugin-shell per ADR-002 (managed subprocess). Spawning the real
// sidecar end-to-end is exercised by the #11 live integration check; the unit
// tests here cover the manager's own state machine.
//
// Note (ADR-002): `CommandChild::kill()` consumes the child, so the handle's
// `kill` takes `self: Box<Self>` and the manager takes the handle out of the
// session before killing it.
//
// The running agent cannot yet read/write Rust-owned memory and audit stores —
// a Node subprocess cannot call Tauri `invoke`, so that requires a dedicated
// Node↔Rust storage bridge, tracked as a follow-up. Until then the spawned
// process runs the minimal `agents/src/sidecar.ts` entrypoint.
//
// See docs/architecture/sdlc-agent-architecture-research-v4.md Section 2.3
// and docs/adr/002-agent-process-strategy.md.

use std::collections::HashMap;
use std::path::Path;

use chrono::Utc;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Lifecycle status of a tracked agent session. Serialized lowercase to match
/// the string the frontend switches on.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentStatus {
    /// The process was spawned and is being tracked.
    Active,
    /// The process finished on its own (reserved for bridge-era exit tracking).
    Completed,
    /// The process failed (reserved for bridge-era exit tracking).
    Failed,
    /// The process was stopped by an explicit `stop` call.
    Stopped,
}

/// A tracked agent session returned across IPC. camelCase for the frontend.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSession {
    pub session_id: String,
    pub project_id: String,
    pub agent_type: String,
    pub task: String,
    pub status: AgentStatus,
    pub started_at: String,
}

/// Everything a spawner needs to launch an agent process for a session.
pub struct AgentSpawnSpec<'a> {
    pub session_id: &'a str,
    pub project_id: &'a str,
    pub project_path: &'a Path,
    pub agent_type: &'a str,
    pub task: &'a str,
}

/// Handle to a spawned agent process. `kill` consumes the handle because the
/// underlying `CommandChild::kill` takes ownership (ADR-002).
pub trait AgentHandle: Send {
    fn kill(self: Box<Self>) -> Result<(), String>;
}

/// Abstraction over launching an agent process, so the manager's lifecycle is
/// testable with a stub and production can use a real Tauri-shell spawner.
pub trait AgentSpawner: Send + Sync {
    fn spawn(&self, spec: &AgentSpawnSpec<'_>) -> Result<Box<dyn AgentHandle>, String>;
}

/// A tracked session plus the live handle used to stop it.
struct RunningSession {
    info: AgentSession,
    /// `Some` while running; taken and consumed on stop.
    handle: Option<Box<dyn AgentHandle>>,
}

/// Tracks running agent sessions and drives their lifecycle through an
/// injected [`AgentSpawner`].
pub struct AgentProcessManager {
    spawner: Box<dyn AgentSpawner>,
    sessions: HashMap<String, RunningSession>,
}

impl AgentProcessManager {
    /// Creates a manager that launches processes through `spawner`.
    pub fn new(spawner: Box<dyn AgentSpawner>) -> Self {
        Self {
            spawner,
            sessions: HashMap::new(),
        }
    }

    /// Spawns an agent for the project and tracks it as an `Active` session.
    /// Returns the new session; if the spawn fails, no session is recorded.
    pub fn start(
        &mut self,
        project_id: &str,
        project_path: &Path,
        agent_type: &str,
        task: &str,
    ) -> Result<AgentSession, String> {
        let session_id = format!("session-{}", Uuid::new_v4());
        let handle = self.spawner.spawn(&AgentSpawnSpec {
            session_id: &session_id,
            project_id,
            project_path,
            agent_type,
            task,
        })?;

        let info = AgentSession {
            session_id: session_id.clone(),
            project_id: project_id.to_string(),
            agent_type: agent_type.to_string(),
            task: task.to_string(),
            status: AgentStatus::Active,
            started_at: Utc::now().to_rfc3339(),
        };
        self.sessions.insert(
            session_id,
            RunningSession {
                info: info.clone(),
                handle: Some(handle),
            },
        );
        Ok(info)
    }

    /// Returns the current status of a session, or an error if unknown.
    pub fn status(&self, session_id: &str) -> Result<AgentStatus, String> {
        self.session_or_err(session_id)
            .map(|s| s.info.status.clone())
    }

    /// Stops a running session: kills the process (if still running) and marks
    /// the session `Stopped`. Returns the updated session, or an error if the
    /// session is unknown. Stopping an already-stopped session is a no-op kill
    /// and returns the session unchanged.
    pub fn stop(&mut self, session_id: &str) -> Result<AgentSession, String> {
        let running = self
            .sessions
            .get_mut(session_id)
            .ok_or_else(|| unknown_session(session_id))?;
        if let Some(handle) = running.handle.take() {
            handle.kill()?;
        }
        running.info.status = AgentStatus::Stopped;
        Ok(running.info.clone())
    }

    fn session_or_err(&self, session_id: &str) -> Result<&RunningSession, String> {
        self.sessions
            .get(session_id)
            .ok_or_else(|| unknown_session(session_id))
    }
}

fn unknown_session(session_id: &str) -> String {
    format!("unknown agent session: {session_id}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Arc;

    /// Records spawn calls and hands out handles whose kill flips a shared flag.
    struct StubSpawner {
        spawn_count: Arc<AtomicUsize>,
        killed: Arc<AtomicBool>,
        fail: bool,
    }

    struct StubHandle {
        killed: Arc<AtomicBool>,
    }

    impl AgentHandle for StubHandle {
        fn kill(self: Box<Self>) -> Result<(), String> {
            self.killed.store(true, Ordering::SeqCst);
            Ok(())
        }
    }

    impl AgentSpawner for StubSpawner {
        fn spawn(&self, _spec: &AgentSpawnSpec<'_>) -> Result<Box<dyn AgentHandle>, String> {
            if self.fail {
                return Err("stub spawn failure".to_string());
            }
            self.spawn_count.fetch_add(1, Ordering::SeqCst);
            Ok(Box::new(StubHandle {
                killed: Arc::clone(&self.killed),
            }))
        }
    }

    fn manager_with(fail: bool) -> (AgentProcessManager, Arc<AtomicUsize>, Arc<AtomicBool>) {
        let spawn_count = Arc::new(AtomicUsize::new(0));
        let killed = Arc::new(AtomicBool::new(false));
        let spawner = StubSpawner {
            spawn_count: Arc::clone(&spawn_count),
            killed: Arc::clone(&killed),
            fail,
        };
        (
            AgentProcessManager::new(Box::new(spawner)),
            spawn_count,
            killed,
        )
    }

    #[test]
    fn test_start_spawns_and_tracks_an_active_session() {
        let (mut manager, spawn_count, _killed) = manager_with(false);
        let session = manager
            .start(
                "proj-1",
                Path::new("/tmp/proj"),
                "code-agent",
                "do the thing",
            )
            .unwrap();

        assert_eq!(session.status, AgentStatus::Active);
        assert_eq!(session.agent_type, "code-agent");
        assert_eq!(spawn_count.load(Ordering::SeqCst), 1);
        assert_eq!(
            manager.status(&session.session_id).unwrap(),
            AgentStatus::Active
        );
    }

    #[test]
    fn test_stop_kills_the_process_and_marks_the_session_stopped() {
        let (mut manager, _count, killed) = manager_with(false);
        let session = manager
            .start("proj-1", Path::new("/tmp/proj"), "code-agent", "task")
            .unwrap();

        let stopped = manager.stop(&session.session_id).unwrap();
        assert_eq!(stopped.status, AgentStatus::Stopped);
        assert!(
            killed.load(Ordering::SeqCst),
            "the process handle was killed"
        );
        assert_eq!(
            manager.status(&session.session_id).unwrap(),
            AgentStatus::Stopped
        );
    }

    #[test]
    fn test_status_and_stop_for_unknown_session_error() {
        let (mut manager, _count, _killed) = manager_with(false);
        assert!(manager.status("nope").is_err());
        assert!(manager.stop("nope").is_err());
    }

    #[test]
    fn test_failed_spawn_records_no_session() {
        let (mut manager, _count, _killed) = manager_with(true);
        let result = manager.start("proj-1", Path::new("/tmp/proj"), "code-agent", "task");
        assert!(result.is_err());
        // Nothing was tracked, so a follow-up status finds no session.
        assert!(manager.status("session-anything").is_err());
    }
}
