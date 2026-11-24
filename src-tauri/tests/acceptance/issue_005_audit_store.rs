// Acceptance: issue #5 — JSONL audit store.
//
// Definition of done: every logged event is appended as one JSON line to a
// per-day file under the project's `.sdlc/audit/` (ADR-001), nothing already
// written is ever lost or reordered, and events come back in the order they
// happened — filtered to exactly what was asked for.
//
// Real store: JSONL files in a temp directory. The tests read events back
// through the store and also read the raw files, so a store that only
// remembered events in memory could not pass.

use std::fs;
use std::path::{Path, PathBuf};

use saor_lib::audit::{AuditEvent, AuditEventType, AuditResult, FileSystemAuditStore};

fn event(id: &str, session_id: &str) -> AuditEvent {
    AuditEvent {
        id: id.to_string(),
        timestamp: "2026-06-01T12:00:00Z".to_string(),
        project_id: "proj-acceptance".to_string(),
        agent_id: "agent:code-agent:acceptance-5".to_string(),
        agent_role: "code-agent".to_string(),
        delegation_chain: vec![
            "human:kevin".to_string(),
            "agent:code-agent:acceptance-5".to_string(),
        ],
        event_type: AuditEventType::ToolInvoked,
        action: "Write".to_string(),
        details: serde_json::json!({ "tool": "Write", "toolUseId": id }),
        issue_ref: Some("5".to_string()),
        initiative_ref: None,
        session_id: session_id.to_string(),
        result: AuditResult::Pending,
        reason: None,
    }
}

fn ids(events: &[AuditEvent]) -> Vec<&str> {
    events.iter().map(|e| e.id.as_str()).collect()
}

/// The audit files under a project, sorted by name.
fn audit_files(project_root: &Path) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = fs::read_dir(project_root.join(".sdlc").join("audit"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect();
    files.sort();
    files
}

/// True for a `YYYY-MM-DD.jsonl` file name.
fn is_day_file(path: &Path) -> bool {
    let name = path.file_name().unwrap().to_str().unwrap();
    let Some(day) = name.strip_suffix(".jsonl") else {
        return false;
    };
    let parts: Vec<&str> = day.split('-').collect();
    parts.len() == 3
        && [4, 2, 2]
            .iter()
            .zip(&parts)
            .all(|(len, part)| part.len() == *len && part.chars().all(|c| c.is_ascii_digit()))
}

#[test]
fn logged_events_land_as_json_lines_in_a_day_file_and_read_back_in_order() {
    let project = tempfile::tempdir().unwrap();
    let store = FileSystemAuditStore::new(project.path()).unwrap();

    // Negative control: before anything is logged there is nothing to read.
    assert!(store.get_recent(10).unwrap().is_empty());
    assert!(audit_files(project.path()).is_empty());

    for id in ["e1", "e2", "e3"] {
        store.log(&event(id, "session-a")).unwrap();
    }

    // Read back through the store, in insertion order, fields intact.
    let events = store.get_by_session("session-a").unwrap();
    assert_eq!(ids(&events), ["e1", "e2", "e3"]);
    assert_eq!(events[0].event_type, AuditEventType::ToolInvoked);
    assert_eq!(events[0].result, AuditResult::Pending);
    assert_eq!(events[0].issue_ref.as_deref(), Some("5"));
    assert_eq!(events[0].delegation_chain[0], "human:kevin");
    assert_eq!(events[0].details["toolUseId"], "e1");

    // Read the raw file: one day file, one JSON object per line, in the
    // camelCase / dot-notation wire format the TypeScript layer shares.
    let files = audit_files(project.path());
    assert_eq!(files.len(), 1);
    assert!(is_day_file(&files[0]), "{}", files[0].display());
    let raw = fs::read_to_string(&files[0]).unwrap();
    let lines: Vec<serde_json::Value> = raw
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(lines.len(), 3);
    assert_eq!(lines[1]["id"], "e2");
    assert_eq!(lines[1]["eventType"], "tool.invoked");
    assert_eq!(lines[1]["sessionId"], "session-a");
    assert_eq!(lines[1]["agentId"], "agent:code-agent:acceptance-5");
}

#[test]
fn the_trail_is_append_only_across_store_instances() {
    let project = tempfile::tempdir().unwrap();
    FileSystemAuditStore::new(project.path())
        .unwrap()
        .log(&event("from-first-run", "session-a"))
        .unwrap();
    let after_first_run = fs::read_to_string(&audit_files(project.path())[0]).unwrap();

    // A later run opens the same project and logs again.
    let second_run = FileSystemAuditStore::new(project.path()).unwrap();
    second_run
        .log(&event("from-second-run", "session-b"))
        .unwrap();

    let after_second_run = fs::read_to_string(&audit_files(project.path())[0]).unwrap();
    assert!(
        after_second_run.starts_with(&after_first_run),
        "the first run's bytes are untouched and the new event follows them"
    );
    assert_eq!(
        ids(&second_run.get_recent(10).unwrap()),
        ["from-second-run", "from-first-run"],
        "get_recent is newest first"
    );

    // Negative control: another project's trail saw none of this.
    let other_project = tempfile::tempdir().unwrap();
    let other = FileSystemAuditStore::new(other_project.path()).unwrap();
    assert!(other.get_recent(10).unwrap().is_empty());
}

#[test]
fn events_from_earlier_day_files_precede_todays() {
    let project = tempfile::tempdir().unwrap();
    let store = FileSystemAuditStore::new(project.path()).unwrap();

    // Two earlier days, written in the store's own line format. The older day
    // is created second so directory order cannot be what sorts them.
    let audit_dir = project.path().join(".sdlc").join("audit");
    for (day, id) in [("2000-01-02", "second-day"), ("2000-01-01", "first-day")] {
        let line = serde_json::to_string(&event(id, "session-a")).unwrap();
        fs::write(audit_dir.join(format!("{day}.jsonl")), format!("{line}\n")).unwrap();
    }
    store.log(&event("today", "session-a")).unwrap();

    assert_eq!(audit_files(project.path()).len(), 3);
    assert_eq!(
        ids(&store.get_by_session("session-a").unwrap()),
        ["first-day", "second-day", "today"]
    );
    assert_eq!(ids(&store.get_recent(1).unwrap()), ["today"]);
}

#[test]
fn a_corrupt_line_is_reported_and_costs_no_other_event() {
    let project = tempfile::tempdir().unwrap();
    let store = FileSystemAuditStore::new(project.path()).unwrap();
    store.log(&event("before", "session-a")).unwrap();

    // Negative control: a clean trail reports no corruption.
    assert!(store.corruption_report().unwrap().is_empty());

    // A torn write, as a crash mid-append would leave it.
    let file = audit_files(project.path()).remove(0);
    let mut raw = fs::read_to_string(&file).unwrap();
    raw.push_str("{\"id\":\"torn\",\"timestamp\":\n");
    fs::write(&file, raw).unwrap();
    store.log(&event("after", "session-a")).unwrap();

    assert_eq!(
        ids(&store.get_by_session("session-a").unwrap()),
        ["before", "after"]
    );
    let report = store.corruption_report().unwrap();
    assert_eq!(report.len(), 1);
    assert_eq!(report[0].file, file);
    assert_eq!(report[0].line_number, 2);
}

#[test]
fn queries_return_exactly_the_events_asked_for() {
    let project = tempfile::tempdir().unwrap();
    let store = FileSystemAuditStore::new(project.path()).unwrap();

    store.log(&event("a-invoked", "session-a")).unwrap();
    let mut violation = event("b-violation", "session-b");
    violation.agent_id = "agent:code-agent:other".to_string();
    violation.event_type = AuditEventType::ScopeViolation;
    violation.result = AuditResult::Blocked;
    violation.reason = Some("File not in agent scope".to_string());
    violation.issue_ref = Some("7".to_string());
    store.log(&violation).unwrap();
    let mut untracked = event("a-untracked", "session-a");
    untracked.issue_ref = None;
    store.log(&untracked).unwrap();

    assert_eq!(
        ids(&store.get_by_session("session-a").unwrap()),
        ["a-invoked", "a-untracked"]
    );
    assert_eq!(
        ids(&store.get_by_agent("agent:code-agent:other").unwrap()),
        ["b-violation"]
    );
    assert_eq!(ids(&store.get_by_issue("5").unwrap()), ["a-invoked"]);
    let violations = store
        .get_by_event_type(&AuditEventType::ScopeViolation)
        .unwrap();
    assert_eq!(ids(&violations), ["b-violation"]);
    assert_eq!(violations[0].result, AuditResult::Blocked);
    assert_eq!(
        violations[0].reason.as_deref(),
        Some("File not in agent scope")
    );

    // Negative controls: a key nothing was logged under matches nothing.
    assert!(store.get_by_session("session-none").unwrap().is_empty());
    assert!(store.get_by_issue("999").unwrap().is_empty());
    assert!(store
        .get_by_event_type(&AuditEventType::CredentialExpired)
        .unwrap()
        .is_empty());
}
