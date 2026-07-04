// commands/agent.rs
//
// Agent-session IPC commands: start an agent (spawn + track + audit), query
// its status, and stop it (kill + audit). The process lifecycle lives in
// AgentProcessManager; these commands wire it to the project registry (to
// locate the project's audit store) and record `agent.created` /
// `agent.completed` lifecycle events, so an agent run is auditable from the
// start.
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
/// store. The agent identity here is synthetic (`agent:{type}:{session}`) —
/// real delegation chains arrive with the identity-carrying MCP writes once
/// the Node↔Rust storage bridge lands.
///
/// Public so the acceptance tests can assert that starting/stopping an agent
/// writes an audit event that reads back from the project's audit store.
pub fn log_lifecycle_event(
    registry: &ProjectRegistry,
    session: &AgentSession,
    event_type: AuditEventType,
    action: String,
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
        result: AuditResult::Success,
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

/// Stops a running agent, records an `agent.completed` audit event, and
/// returns the final status.
#[tauri::command]
pub fn agent_stop(
    registry: State<'_, RegistryState>,
    manager: State<'_, ManagerState>,
    session_id: String,
) -> Result<AgentStatus, String> {
    let session = {
        let mut manager = manager.lock().map_err(|e| e.to_string())?;
        manager.stop(&session_id)?
    };

    {
        let registry = registry.lock().map_err(|e| e.to_string())?;
        log_lifecycle_event(
            &registry,
            &session,
            AuditEventType::AgentCompleted,
            format!("Stopped {} agent", session.agent_type),
            Some("stopped by user".to_string()),
        )?;
    }

    Ok(session.status)
}
