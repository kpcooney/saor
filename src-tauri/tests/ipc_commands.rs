// src-tauri/tests/ipc_commands.rs
//
// Acceptance tests for the Phase 1 IPC command layer (issue #12). These drive
// the project/memory/audit command-logic functions against REAL backends —
// a temp-dir project registry and its on-disk .sdlc stores, no mocks — and
// read side effects back. Each capability carries a negative control so a
// green run cannot be green for the wrong reason.
//
// The thin `#[tauri::command]` wrappers add only state-locking over these
// functions and are not exercised here (they need a Tauri runtime). Agent-
// session behavior is unit-tested next to the code (see the note at the end).

use std::path::Path;

use saor_lib::audit::{AuditEvent, AuditEventType, AuditResult, FileSystemAuditStore};
use saor_lib::commands::{audit, memory};
use saor_lib::project::{ProjectRecord, ProjectRegistry};

/// Creates an in-memory registry plus a registered project under a temp dir.
fn registry_with_project() -> (ProjectRegistry, ProjectRecord, tempfile::TempDir) {
    let tmp = tempfile::tempdir().unwrap();
    let registry = ProjectRegistry::open_in_memory().unwrap();
    let project = registry
        .create("Acceptance", &tmp.path().join("proj"), "acceptance project")
        .unwrap();
    (registry, project, tmp)
}

// --- Project commands -------------------------------------------------------

#[test]
fn create_project_writes_sdlc_tree_and_get_reads_it_back() {
    let (registry, project, _tmp) = registry_with_project();

    // Side effect on disk: the memory DB and audit dir exist.
    assert!(Path::new(&project.path)
        .join(".sdlc")
        .join("memory.db")
        .exists());
    assert!(Path::new(&project.path)
        .join(".sdlc")
        .join("audit")
        .is_dir());

    // Read back through get + list.
    assert_eq!(registry.get(&project.id).unwrap(), project);
    assert_eq!(registry.list().unwrap().len(), 1);
}

#[test]
fn get_unknown_project_errors_and_duplicate_path_does_not_clobber() {
    let (registry, project, tmp) = registry_with_project();

    // Negative control: unknown id is an error, not a fabricated record.
    assert!(registry.get("no-such-id").is_err());

    // Negative control: re-creating onto the same path errors without
    // clobbering the original.
    let dup = registry.create("Other", &tmp.path().join("proj"), "dup");
    assert!(dup.is_err());
    assert_eq!(registry.get(&project.id).unwrap().name, "Acceptance");
    assert_eq!(registry.list().unwrap().len(), 1);
}

// --- Memory commands --------------------------------------------------------

#[test]
fn memory_write_then_search_and_read_round_trips_a_known_entry() {
    let (registry, project, _tmp) = registry_with_project();

    let id = memory::write(
        &registry,
        &project.id,
        "learning",
        "FTS5 keeps the memory index in sync via triggers",
        Some(serde_json::json!({ "source": "acceptance" })),
    )
    .unwrap();

    // Search finds it by keyword.
    let hits = memory::search(&registry, &project.id, "FTS5", None).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].id, id);

    // A limit of 0 returns nothing even for a matching query (limit semantics
    // match audit_get_recent), rather than silently clamping up to one result.
    assert!(memory::search(&registry, &project.id, "FTS5", Some(0))
        .unwrap()
        .is_empty());

    // Read by id returns the same entry, fields intact.
    let entry = memory::read(&registry, &project.id, &id).unwrap();
    assert_eq!(
        entry.content,
        "FTS5 keeps the memory index in sync via triggers"
    );
    assert_eq!(entry.metadata["source"], "acceptance");
    // IPC writes are stamped as user-authored until the agent bridge (#59).
    assert_eq!(entry.created_by, "user");
}

#[test]
fn memory_negative_controls_unknown_id_invalid_category_and_no_match() {
    let (registry, project, _tmp) = registry_with_project();

    // Unknown entry id → error, not a fabricated entry.
    assert!(memory::read(&registry, &project.id, "missing").is_err());

    // Invalid category → error before any write.
    assert!(memory::write(&registry, &project.id, "bogus", "x", None).is_err());

    // Search for an unwritten term → empty, not everything.
    memory::write(&registry, &project.id, "learning", "rust ownership", None).unwrap();
    assert!(memory::search(&registry, &project.id, "javascript", None)
        .unwrap()
        .is_empty());

    // Unknown project → error.
    assert!(memory::search(&registry, "no-project", "anything", None).is_err());
}

// --- Audit commands ---------------------------------------------------------

/// Logs an event straight into a project's audit store (as the hook layer
/// would), so the read commands have something to return.
fn log_event(project_path: &str, id: &str, session: &str, agent: &str, kind: AuditEventType) {
    let store = FileSystemAuditStore::new(Path::new(project_path)).unwrap();
    store
        .log(&AuditEvent {
            id: id.to_string(),
            timestamp: "2026-07-04T12:00:00Z".to_string(),
            project_id: "acceptance".to_string(),
            agent_id: agent.to_string(),
            agent_role: "code-agent".to_string(),
            delegation_chain: vec!["human:kevin".to_string()],
            event_type: kind,
            action: format!("event {id}"),
            details: serde_json::json!({}),
            issue_ref: None,
            initiative_ref: None,
            session_id: session.to_string(),
            result: AuditResult::Success,
            reason: None,
        })
        .unwrap();
}

#[test]
fn audit_reads_back_events_by_session_agent_and_recency() {
    let (registry, project, _tmp) = registry_with_project();
    log_event(
        &project.path,
        "e1",
        "session-a",
        "agent:x",
        AuditEventType::ToolInvoked,
    );
    log_event(
        &project.path,
        "e2",
        "session-b",
        "agent:y",
        AuditEventType::ToolInvoked,
    );
    log_event(
        &project.path,
        "e3",
        "session-a",
        "agent:x",
        AuditEventType::ToolCompleted,
    );

    let by_session = audit::by_session(&registry, &project.id, "session-a").unwrap();
    assert_eq!(by_session.len(), 2);

    let by_agent = audit::by_agent(&registry, &project.id, "agent:y").unwrap();
    assert_eq!(by_agent.len(), 1);
    assert_eq!(by_agent[0].id, "e2");

    // Recent returns newest first, honoring the limit.
    let recent = audit::recent(&registry, &project.id, Some(2)).unwrap();
    assert_eq!(recent.len(), 2);
    assert_eq!(recent[0].id, "e3", "recent events are newest-first");
}

#[test]
fn audit_negative_controls_unknown_project_and_empty_history() {
    let (registry, project, _tmp) = registry_with_project();

    // Unknown project → error.
    assert!(audit::recent(&registry, "no-project", None).is_err());

    // A fresh project has no events — an empty list, not an error.
    assert!(audit::recent(&registry, &project.id, None)
        .unwrap()
        .is_empty());
    assert!(audit::by_session(&registry, &project.id, "any")
        .unwrap()
        .is_empty());
}

// Agent-session behavior is covered without a Tauri runtime by unit tests
// close to the code: the process lifecycle (start → active → stop → stopped,
// idempotent stop) in src/process/manager.rs, and the lifecycle→audit wiring
// in src/commands/agent.rs. Spawning the real sidecar is the #11 live check.
