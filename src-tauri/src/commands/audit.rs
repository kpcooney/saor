// commands/audit.rs
//
// Audit IPC commands: fetch events for a session, for an agent, or the most
// recent N across the project. Each resolves the project's audit directory
// via the registry and reads through the FileSystemAuditStore. The plain
// functions take a `&ProjectRegistry` for direct testing; the tauri wrappers
// add state-locking and error-stringing.

use tauri::State;

use crate::audit::{AuditEvent, FileSystemAuditStore};
use crate::commands::project::RegistryState;
use crate::project::ProjectRegistry;

/// Default number of events returned by `audit_get_recent` when the caller
/// gives no limit.
const DEFAULT_RECENT_LIMIT: usize = 50;

/// Opens the audit store rooted at a project resolved through the registry.
fn open_store(
    registry: &ProjectRegistry,
    project_id: &str,
) -> Result<FileSystemAuditStore, String> {
    let root = registry.path_for(project_id).map_err(|e| e.to_string())?;
    FileSystemAuditStore::new(&root).map_err(|e| e.to_string())
}

/// Returns all events from a session within the project.
pub fn by_session(
    registry: &ProjectRegistry,
    project_id: &str,
    session_id: &str,
) -> Result<Vec<AuditEvent>, String> {
    open_store(registry, project_id)?
        .get_by_session(session_id)
        .map_err(|e| e.to_string())
}

/// Returns all events from an agent within the project.
pub fn by_agent(
    registry: &ProjectRegistry,
    project_id: &str,
    agent_id: &str,
) -> Result<Vec<AuditEvent>, String> {
    open_store(registry, project_id)?
        .get_by_agent(agent_id)
        .map_err(|e| e.to_string())
}

/// Returns the most recent `limit` events (newest first) within the project.
pub fn recent(
    registry: &ProjectRegistry,
    project_id: &str,
    limit: Option<usize>,
) -> Result<Vec<AuditEvent>, String> {
    open_store(registry, project_id)?
        .get_recent(limit.unwrap_or(DEFAULT_RECENT_LIMIT))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn audit_get_by_session(
    registry: State<'_, RegistryState>,
    project_id: String,
    session_id: String,
) -> Result<Vec<AuditEvent>, String> {
    let registry = registry.lock().map_err(|e| e.to_string())?;
    by_session(&registry, &project_id, &session_id)
}

#[tauri::command]
pub fn audit_get_by_agent(
    registry: State<'_, RegistryState>,
    project_id: String,
    agent_id: String,
) -> Result<Vec<AuditEvent>, String> {
    let registry = registry.lock().map_err(|e| e.to_string())?;
    by_agent(&registry, &project_id, &agent_id)
}

#[tauri::command]
pub fn audit_get_recent(
    registry: State<'_, RegistryState>,
    project_id: String,
    limit: Option<usize>,
) -> Result<Vec<AuditEvent>, String> {
    let registry = registry.lock().map_err(|e| e.to_string())?;
    recent(&registry, &project_id, limit)
}
