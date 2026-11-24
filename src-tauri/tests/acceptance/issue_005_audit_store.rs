// src-tauri/tests/acceptance/issue_005_audit_store.rs
//
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
//
// Two limits of what this file pins, both because the store takes the day from
// the system clock and offers no way to set it:
//   - A day file's name is checked to be a real calendar date, not to be the
//     *right* date. Events on different days are simulated by writing the
//     earlier days' files by hand.
//   - The tests never assume all of "today's" events share one file, so a run
//     that straddles midnight UTC still passes.

use std::fs;
use std::path::{Path, PathBuf};

use chrono::NaiveDate;

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

/// True for a `YYYY-MM-DD.jsonl` file name whose stem is a real calendar date.
fn is_day_file(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .and_then(|name| name.strip_suffix(".jsonl"))
        .is_some_and(|day| day.len() == 10 && NaiveDate::parse_from_str(day, "%Y-%m-%d").is_ok())
}

/// Every line of every audit file, in file-name order: the whole trail as it
/// is on disk.
fn raw_trail(project_root: &Path) -> String {
    audit_files(project_root)
        .iter()
        .map(|file| fs::read_to_string(file).unwrap())
        .collect()
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

    // Read the raw files: only day files, one JSON object per line, in the
    // camelCase / dot-notation wire format the TypeScript layer shares.
    let files = audit_files(project.path());
    assert!(!files.is_empty());
    for file in &files {
        assert!(is_day_file(file), "{}", file.display());
    }
    assert!(!is_day_file(Path::new("2026-13-45.jsonl")));
    assert!(!is_day_file(Path::new("audit.jsonl")));
    let raw = raw_trail(project.path());
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
    let after_first_run = raw_trail(project.path());
    assert_eq!(after_first_run.lines().count(), 1);

    // A later run opens the same project and logs again.
    let second_run = FileSystemAuditStore::new(project.path()).unwrap();
    second_run
        .log(&event("from-second-run", "session-b"))
        .unwrap();

    let after_second_run = raw_trail(project.path());
    assert!(
        after_second_run.starts_with(&after_first_run),
        "the first run's bytes are untouched and the new event follows them"
    );
    assert_eq!(after_second_run.lines().count(), 2);
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
    // get_recent walks back across day files, newest first, and its limit
    // cuts from the old end.
    assert_eq!(
        ids(&store.get_recent(10).unwrap()),
        ["today", "second-day", "first-day"]
    );
    assert_eq!(ids(&store.get_recent(2).unwrap()), ["today", "second-day"]);
}

#[test]
fn a_malformed_line_is_reported_and_costs_no_other_event() {
    let project = tempfile::tempdir().unwrap();
    let store = FileSystemAuditStore::new(project.path()).unwrap();
    store.log(&event("before", "session-a")).unwrap();

    // Negative control: a clean trail reports no corruption.
    assert!(store.corruption_report().unwrap().is_empty());

    // A complete line that is not a valid event, as a manual edit or an older
    // schema would leave it. (A write torn by a crash is a different case: it
    // has no trailing newline. The next test covers it.)
    let file = audit_files(project.path()).pop().unwrap();
    let mut raw = fs::read_to_string(&file).unwrap();
    raw.push_str("{\"id\":\"malformed\",\"timestamp\":\n");
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
fn an_event_logged_after_a_crash_torn_line_is_not_lost() {
    let project = tempfile::tempdir().unwrap();
    FileSystemAuditStore::new(project.path())
        .unwrap()
        .log(&event("before", "session-a"))
        .unwrap();

    // A write cut off by a crash: part of an event and no trailing newline
    // (issue #74). Unlike the malformed line above, the file now ends
    // mid-line.
    let torn = "{\"id\":\"torn\",\"timestamp\":";
    let file = audit_files(project.path()).pop().unwrap();
    let mut raw = fs::read_to_string(&file).unwrap();
    raw.push_str(torn);
    fs::write(&file, &raw).unwrap();

    // The run after the crash opens the same project and logs again.
    let store = FileSystemAuditStore::new(project.path()).unwrap();

    // Negative control: before that log, the fragment is the last thing in the
    // trail, already reported, and only "before" can be read.
    assert!(raw_trail(project.path()).ends_with(torn));
    assert_eq!(store.corruption_report().unwrap().len(), 1);
    assert_eq!(ids(&store.get_recent(10).unwrap()), ["before"]);

    store.log(&event("after", "session-a")).unwrap();

    // The new event is not glued to the fragment: every query that should see
    // it does.
    assert_eq!(
        ids(&store.get_by_session("session-a").unwrap()),
        ["before", "after"]
    );
    assert_eq!(ids(&store.get_recent(10).unwrap()), ["after", "before"]);

    // The fragment is still reported, alone, on its own line.
    let report = store.corruption_report().unwrap();
    assert_eq!(report.len(), 1);
    assert_eq!(report[0].file, file);
    assert_eq!(report[0].line_number, 2);

    // Read the raw file: nothing already written was touched, the fragment
    // sits on a line by itself, and the new event is a whole line after it.
    let after_log = fs::read_to_string(&file).unwrap();
    assert!(after_log.starts_with(&raw));
    assert!(after_log.ends_with('\n'));
    let lines: Vec<&str> = after_log.lines().collect();
    assert_eq!(lines.len(), 3);
    assert_eq!(lines[1], torn);
    let last: serde_json::Value = serde_json::from_str(lines[2]).unwrap();
    assert_eq!(last["id"], "after");
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
