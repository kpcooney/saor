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
// A session leaves `Active` in one of two ways: an explicit `stop` (the manager
// kills the process → `Stopped`), or the process exiting on its own, which the
// spawner reports through `mark_exited` (→ `Completed` or `Failed`). Whichever
// happens first wins; the other is then a no-op.
//
// The running agent reaches the Rust-owned memory and audit stores through the
// Node↔Rust storage bridge (bridge/, ADR-009), which the spawner attaches to
// the process it launches.
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
    /// The process finished on its own with a zero exit code.
    Completed,
    /// The process exited on its own with a non-zero code or was killed by a
    /// signal the manager did not send.
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

    /// Stops a running session: kills the process and marks the session
    /// `Stopped`. Returns the updated session, or an error if the session is
    /// unknown. Stopping a session that is no longer `Active` — already
    /// stopped, or already exited on its own — is a no-op and returns the
    /// session unchanged.
    pub fn stop(&mut self, session_id: &str) -> Result<AgentSession, String> {
        let running = self
            .sessions
            .get_mut(session_id)
            .ok_or_else(|| unknown_session(session_id))?;
        if running.info.status == AgentStatus::Active {
            if let Some(handle) = running.handle.take() {
                handle.kill()?;
            }
            running.info.status = AgentStatus::Stopped;
        }
        Ok(running.info.clone())
    }

    /// Records that a session's process exited on its own: `Completed` when
    /// `succeeded`, otherwise `Failed`.
    ///
    /// Returns the updated session only when this call made the transition.
    /// It returns `None` — and changes nothing — for an unknown session or one
    /// that already left `Active`, which is what happens when the exit being
    /// reported is the kill from an earlier `stop`. Callers use the `Some` to
    /// decide whether there is a lifecycle event to record.
    pub fn mark_exited(&mut self, session_id: &str, succeeded: bool) -> Option<AgentSession> {
        let running = self.sessions.get_mut(session_id)?;
        if running.info.status != AgentStatus::Active {
            return None;
        }
        // The process is gone; drop the handle so nothing tries to kill it.
        running.handle = None;
        running.info.status = if succeeded {
            AgentStatus::Completed
        } else {
            AgentStatus::Failed
        };
        Some(running.info.clone())
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
    fn test_stop_is_idempotent_second_call_is_a_noop() {
        let (mut manager, _count, killed) = manager_with(false);
        let session = manager
            .start("proj-1", Path::new("/tmp/proj"), "code-agent", "task")
            .unwrap();

        manager.stop(&session.session_id).unwrap();
        killed.store(false, Ordering::SeqCst); // reset so a second kill would show

        // Second stop: the handle was already taken, so no kill fires, and the
        // session stays Stopped (no panic on the consumed handle).
        let again = manager.stop(&session.session_id).unwrap();
        assert_eq!(again.status, AgentStatus::Stopped);
        assert!(
            !killed.load(Ordering::SeqCst),
            "second stop must not kill again"
        );
    }

    #[test]
    fn test_mark_exited_records_completed_or_failed_for_an_active_session() {
        let (mut manager, _count, killed) = manager_with(false);
        let ok = manager
            .start("proj-1", Path::new("/tmp/proj"), "code-agent", "task")
            .unwrap();
        let bad = manager
            .start("proj-1", Path::new("/tmp/proj"), "code-agent", "task")
            .unwrap();

        let completed = manager.mark_exited(&ok.session_id, true).unwrap();
        assert_eq!(completed.status, AgentStatus::Completed);
        let failed = manager.mark_exited(&bad.session_id, false).unwrap();
        assert_eq!(failed.status, AgentStatus::Failed);
        assert_eq!(
            manager.status(&bad.session_id).unwrap(),
            AgentStatus::Failed
        );

        // Stopping a session that already exited neither kills nor relabels it.
        let after_stop = manager.stop(&ok.session_id).unwrap();
        assert_eq!(after_stop.status, AgentStatus::Completed);
        assert!(
            !killed.load(Ordering::SeqCst),
            "no kill for an exited process"
        );
    }

    #[test]
    fn test_mark_exited_is_a_noop_once_the_session_left_active() {
        let (mut manager, _count, _killed) = manager_with(false);
        let session = manager
            .start("proj-1", Path::new("/tmp/proj"), "code-agent", "task")
            .unwrap();

        // The exit that follows an explicit stop is the kill itself, not a
        // failure: the session stays Stopped and no transition is reported.
        manager.stop(&session.session_id).unwrap();
        assert!(manager.mark_exited(&session.session_id, false).is_none());
        assert_eq!(
            manager.status(&session.session_id).unwrap(),
            AgentStatus::Stopped
        );

        // A second exit report for the same session, and one for an unknown
        // session, are likewise ignored.
        assert!(manager.mark_exited(&session.session_id, true).is_none());
        assert!(manager.mark_exited("nope", true).is_none());
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
