// commands/agent.rs
//
// Agent-session IPC commands: start an agent (spawn + track + audit), query
// its status, and stop it (kill + audit). The process lifecycle lives in
// AgentProcessManager; these commands wire it to the project registry (to
// locate the project's audit store) and record the lifecycle events, so an
// agent run is auditable from the start.
//
// Rust is the single author of lifecycle events because it observes every
// spawn, stop, and exit (ADR-009): `agent.created` on start, then exactly one
// of `agent.completed` (stopped by the user, or exited cleanly) or
// `agent.failed` (exited with an error). `record_agent_exit` is the entry
// point the spawner calls when a process ends on its own.
//
// Registry and manager locks are never held simultaneously — each is acquired,
// used, and released in turn — so the two commands cannot deadlock against
// each other regardless of lock ordering.

use std::sync::Mutex;

use chrono::Utc;
use serde_json::json;
use tauri::State;
use uuid::Uuid;

use crate::audit::{AuditEvent, AuditEventType, AuditResult, FileSystemAuditStore};
use crate::commands::project::RegistryState;
use crate::process::manager::{AgentProcessManager, AgentSession, AgentStatus};
use crate::project::ProjectRegistry;

/// Shared, lock-guarded process manager held in Tauri managed state.
pub type ManagerState = Mutex<AgentProcessManager>;

/// Records a lifecycle audit event for a session into its project's audit
/// store.
///
/// The agent id is derived as `agent:{type}:{session}`. The sidecar derives
/// its own identity id the same way (agents/src/sidecar-runner.ts), so these
/// events and the tool/memory events the agent writes through the storage
/// bridge share one `agentId` and one delegation chain.
fn log_lifecycle_event(
    registry: &ProjectRegistry,
    session: &AgentSession,
    event_type: AuditEventType,
    action: String,
    result: AuditResult,
    reason: Option<String>,
) -> Result<(), String> {
    let root = registry
        .path_for(&session.project_id)
        .map_err(|e| e.to_string())?;
    let store = FileSystemAuditStore::new(&root).map_err(|e| e.to_string())?;

    let agent_id = format!("agent:{}:{}", session.agent_type, session.session_id);
    let event = AuditEvent {
        id: Uuid::new_v4().to_string(),
        timestamp: Utc::now().to_rfc3339(),
        project_id: session.project_id.clone(),
        agent_id: agent_id.clone(),
        agent_role: session.agent_type.clone(),
        delegation_chain: vec!["human:local".to_string(), agent_id],
        event_type,
        action,
        details: json!({ "task": session.task, "sessionId": session.session_id }),
        issue_ref: None,
        initiative_ref: None,
        session_id: session.session_id.clone(),
        result,
        reason,
    };
    store.log(&event).map_err(|e| e.to_string())
}

/// Starts an agent for a project and returns its session id. Spawns and tracks
/// the process, then records an `agent.created` audit event.
#[tauri::command]
pub fn agent_start(
    registry: State<'_, RegistryState>,
    manager: State<'_, ManagerState>,
    project_id: String,
    agent_type: String,
    task: String,
) -> Result<String, String> {
    // Resolve the project path (and validate the project exists) first,
    // releasing the registry lock before touching the manager.
    let project_path = {
        let registry = registry.lock().map_err(|e| e.to_string())?;
        registry.path_for(&project_id).map_err(|e| e.to_string())?
    };

    let session = {
        let mut manager = manager.lock().map_err(|e| e.to_string())?;
        manager.start(&project_id, &project_path, &agent_type, &task)?
    };

    {
        let registry = registry.lock().map_err(|e| e.to_string())?;
        log_lifecycle_event(
            &registry,
            &session,
            AuditEventType::AgentCreated,
            format!("Started {agent_type} agent"),
            AuditResult::Success,
            None,
        )?;
    }

    Ok(session.session_id)
}

/// Returns the current status of a tracked agent session.
#[tauri::command]
pub fn agent_status(
    manager: State<'_, ManagerState>,
    session_id: String,
) -> Result<AgentStatus, String> {
    let manager = manager.lock().map_err(|e| e.to_string())?;
    manager.status(&session_id)
}

/// Stops a running agent and returns the session's final status. Records an
/// `agent.completed` audit event when this call is what ended the run; stopping
/// a session that had already stopped or exited records nothing further.
#[tauri::command]
pub fn agent_stop(
    registry: State<'_, RegistryState>,
    manager: State<'_, ManagerState>,
    session_id: String,
) -> Result<AgentStatus, String> {
    stop_agent(&registry, &manager, &session_id)
}

/// The logic behind [`agent_stop`], taking the shared state directly so it is
/// testable without a Tauri runtime.
fn stop_agent(
    registry: &RegistryState,
    manager: &ManagerState,
    session_id: &str,
) -> Result<AgentStatus, String> {
    let (session, was_active) = {
        let mut manager = manager.lock().map_err(|e| e.to_string())?;
        let was_active = manager.status(session_id)? == AgentStatus::Active;
        (manager.stop(session_id)?, was_active)
    };

    if was_active {
        let registry = registry.lock().map_err(|e| e.to_string())?;
        log_lifecycle_event(
            &registry,
            &session,
            AuditEventType::AgentCompleted,
            format!("Stopped {} agent", session.agent_type),
            AuditResult::Success,
            Some("stopped by user".to_string()),
        )?;
    }

    Ok(session.status)
}

/// Records that an agent process exited on its own. Called by the spawner when
/// the process terminates.
///
/// Marks the session `Completed` (exit code 0) or `Failed` (anything else) and
/// records the matching `agent.completed` / `agent.failed` event. If the
/// session had already left `Active` — the exit is the kill from an earlier
/// stop — nothing changes and nothing is logged, so each run ends with exactly
/// one terminal lifecycle event.
///
/// `failure_reason` is the error the sidecar reported on its `failed` status
/// line, when it got the chance to report one; otherwise the reason falls back
/// to the exit code.
pub fn record_agent_exit(
    registry: &RegistryState,
    manager: &ManagerState,
    session_id: &str,
    exit_code: Option<i32>,
    failure_reason: Option<String>,
) -> Result<(), String> {
    let succeeded = exit_code == Some(0);
    let session = {
        let mut manager = manager.lock().map_err(|e| e.to_string())?;
        manager.mark_exited(session_id, succeeded)
    };
    let Some(session) = session else {
        return Ok(());
    };

    let registry = registry.lock().map_err(|e| e.to_string())?;
    if succeeded {
        return log_lifecycle_event(
            &registry,
            &session,
            AuditEventType::AgentCompleted,
            format!("{} agent completed", session.agent_type),
            AuditResult::Success,
            None,
        );
    }
    let reason = failure_reason.unwrap_or_else(|| match exit_code {
        Some(code) => format!("agent process exited with code {code}"),
        None => "agent process was terminated by a signal".to_string(),
    });
    log_lifecycle_event(
        &registry,
        &session,
        AuditEventType::AgentFailed,
        format!("{} agent failed", session.agent_type),
        AuditResult::Failure,
        Some(reason),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::process::manager::{AgentHandle, AgentSession, AgentSpawnSpec, AgentSpawner};

    fn session(project_id: &str) -> AgentSession {
        AgentSession {
            session_id: "session-1".to_string(),
            project_id: project_id.to_string(),
            agent_type: "code-agent".to_string(),
            task: "do the thing".to_string(),
            status: AgentStatus::Active,
            started_at: "2026-07-05T12:00:00Z".to_string(),
        }
    }

    #[test]
    fn test_lifecycle_events_are_written_to_the_project_audit_store() {
        let tmp = tempfile::tempdir().unwrap();
        let registry = ProjectRegistry::open_in_memory().unwrap();
        let project = registry
            .create("Acceptance", &tmp.path().join("proj"), "")
            .unwrap();
        let session = session(&project.id);

        log_lifecycle_event(
            &registry,
            &session,
            AuditEventType::AgentCreated,
            "Started code-agent agent".to_string(),
            AuditResult::Success,
            None,
        )
        .unwrap();
        log_lifecycle_event(
            &registry,
            &session,
            AuditEventType::AgentCompleted,
            "Stopped code-agent agent".to_string(),
            AuditResult::Success,
            Some("stopped by user".to_string()),
        )
        .unwrap();

        // Both lifecycle events read back from the project's audit store,
        // grouped by the session id, stamped with the synthetic agent identity.
        let store = FileSystemAuditStore::new(&tmp.path().join("proj")).unwrap();
        let events = store.get_by_session(&session.session_id).unwrap();
        let types: Vec<&AuditEventType> = events.iter().map(|e| &e.event_type).collect();
        assert!(types.contains(&&AuditEventType::AgentCreated));
        assert!(types.contains(&&AuditEventType::AgentCompleted));
        assert_eq!(events[0].agent_role, "code-agent");
        assert_eq!(events[0].session_id, "session-1");
    }

    #[test]
    fn test_lifecycle_event_for_unknown_project_errors() {
        let registry = ProjectRegistry::open_in_memory().unwrap();
        let result = log_lifecycle_event(
            &registry,
            &session("no-such-project"),
            AuditEventType::AgentCreated,
            "Started".to_string(),
            AuditResult::Success,
            None,
        );
        assert!(result.is_err());
    }

    // --- Exit tracking ------------------------------------------------------

    /// Spawns nothing; hands out handles whose kill always succeeds.
    struct NoopSpawner;
    struct NoopHandle;

    impl AgentHandle for NoopHandle {
        fn kill(self: Box<Self>) -> Result<(), String> {
            Ok(())
        }
    }

    impl AgentSpawner for NoopSpawner {
        fn spawn(&self, _spec: &AgentSpawnSpec<'_>) -> Result<Box<dyn AgentHandle>, String> {
            Ok(Box::new(NoopHandle))
        }
    }

    /// Shared state with one registered project and one started session.
    fn running_session() -> (RegistryState, ManagerState, AgentSession, tempfile::TempDir) {
        let tmp = tempfile::tempdir().unwrap();
        let project_path = tmp.path().join("proj");
        let registry = ProjectRegistry::open_in_memory().unwrap();
        let project = registry.create("Acceptance", &project_path, "").unwrap();
        let mut manager = AgentProcessManager::new(Box::new(NoopSpawner));
        let session = manager
            .start(&project.id, &project_path, "code-agent", "task")
            .unwrap();
        (Mutex::new(registry), Mutex::new(manager), session, tmp)
    }

    /// Reads back the session's lifecycle events from the real audit store.
    fn events_for(tmp: &tempfile::TempDir, session: &AgentSession) -> Vec<AuditEvent> {
        FileSystemAuditStore::new(&tmp.path().join("proj"))
            .unwrap()
            .get_by_session(&session.session_id)
            .unwrap()
    }

    #[test]
    fn test_clean_exit_marks_completed_and_logs_agent_completed() {
        let (registry, manager, session, tmp) = running_session();

        record_agent_exit(&registry, &manager, &session.session_id, Some(0), None).unwrap();

        assert_eq!(
            manager.lock().unwrap().status(&session.session_id).unwrap(),
            AgentStatus::Completed
        );
        let events = events_for(&tmp, &session);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event_type, AuditEventType::AgentCompleted);
        assert_eq!(events[0].result, AuditResult::Success);
    }

    #[test]
    fn test_failed_exit_marks_failed_and_logs_the_sidecar_reason() {
        let (registry, manager, session, tmp) = running_session();

        record_agent_exit(
            &registry,
            &manager,
            &session.session_id,
            Some(1),
            Some("model call failed".to_string()),
        )
        .unwrap();

        assert_eq!(
            manager.lock().unwrap().status(&session.session_id).unwrap(),
            AgentStatus::Failed
        );
        let events = events_for(&tmp, &session);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event_type, AuditEventType::AgentFailed);
        assert_eq!(events[0].result, AuditResult::Failure);
        assert_eq!(events[0].reason.as_deref(), Some("model call failed"));
    }

    #[test]
    fn test_failed_exit_without_a_reported_reason_falls_back_to_the_exit_code() {
        let (registry, manager, session, tmp) = running_session();

        record_agent_exit(&registry, &manager, &session.session_id, Some(7), None).unwrap();

        let events = events_for(&tmp, &session);
        assert_eq!(
            events[0].reason.as_deref(),
            Some("agent process exited with code 7")
        );
    }

    #[test]
    fn test_each_run_ends_with_exactly_one_terminal_lifecycle_event() {
        // Stop first, then the kill's own exit arrives: one event, Stopped.
        let (registry, manager, session, tmp) = running_session();
        let status = stop_agent(&registry, &manager, &session.session_id).unwrap();
        assert_eq!(status, AgentStatus::Stopped);
        record_agent_exit(&registry, &manager, &session.session_id, None, None).unwrap();
        let events = events_for(&tmp, &session);
        assert_eq!(events.len(), 1, "the kill's exit must not log a failure");
        assert_eq!(events[0].event_type, AuditEventType::AgentCompleted);
        assert_eq!(events[0].reason.as_deref(), Some("stopped by user"));

        // Exit first, then a late stop: one event, still Completed.
        let (registry, manager, session, tmp) = running_session();
        record_agent_exit(&registry, &manager, &session.session_id, Some(0), None).unwrap();
        let status = stop_agent(&registry, &manager, &session.session_id).unwrap();
        assert_eq!(status, AgentStatus::Completed);
        assert_eq!(events_for(&tmp, &session).len(), 1);
    }
}
