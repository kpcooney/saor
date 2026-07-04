// audit/store.rs
//
// FileSystemAuditStore — the Phase 1 implementation of the audit store,
// writing append-only JSONL files. Each line is a serialized AuditEvent.
// The store supports basic query operations (by agent, by session, by
// event type) by reading and filtering the JSONL files.
//
// File naming follows ADR-001: one JSONL file per calendar day, named
// YYYY-MM-DD.jsonl. All sessions on the same day write to the same file,
// with events interleaved chronologically. The sessionId field on each
// event enables per-session filtering.
//
// JSONL files are written to {project_path}/.sdlc/audit/. For Phase 1
// project scale, full-file scans are fast enough. The SqliteAuditStore
// upgrade path (Phase 4+) will take over without changing the hook layer.
//
// See docs/architecture/sdlc-agent-architecture-research-v4.md Section 8.4
// for the FileSystemAuditStore design and the SqliteAuditStore upgrade path.

use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

use chrono::Utc;

use super::schema::{AuditError, AuditEvent, AuditEventType, MalformedLine};

/// Append-only JSONL audit store. Writes events to per-day files under
/// `{project_path}/.sdlc/audit/` following the granularity strategy
/// from ADR-001.
///
/// Each call to `log()` appends a single JSON line to today's file.
/// Query methods read all files and filter in memory — acceptable for
/// Phase 1 scale (expect tens of MB of audit history before the
/// SqliteAuditStore migration becomes warranted; see Phase 4 in
/// architecture Section 8.4).
pub struct FileSystemAuditStore {
    audit_dir: PathBuf,
}

impl FileSystemAuditStore {
    /// Creates a new audit store rooted at `{project_path}/.sdlc/audit/`.
    /// Creates the directory if it doesn't exist.
    pub fn new(project_path: &Path) -> Result<Self, AuditError> {
        let audit_dir = project_path.join(".sdlc").join("audit");
        fs::create_dir_all(&audit_dir).map_err(|e| {
            AuditError::DirectoryCreation(format!("failed to create {}: {e}", audit_dir.display()))
        })?;
        Ok(Self { audit_dir })
    }

    /// Appends a single audit event as a JSON line to today's file.
    ///
    /// The file is created if it doesn't exist. Each event is a single
    /// line — no multi-line records.
    ///
    /// Concurrency: Phase 1 runs a single agent at a time, so this
    /// method does not implement explicit serialization. POSIX `O_APPEND`
    /// makes a single `write()` call atomic only up to `PIPE_BUF`
    /// (~4 KiB on most systems), and `writeln!` may issue multiple
    /// writes for a large event — so concurrent multi-process callers
    /// could interleave a single event's bytes. Adding a `Mutex<File>`
    /// or a single `write_all` of a pre-built buffer is deferred until
    /// concurrent agents become a real Phase 2 requirement.
    pub fn log(&self, event: &AuditEvent) -> Result<(), AuditError> {
        let filename = format!("{}.jsonl", Utc::now().format("%Y-%m-%d"));
        let file_path = self.audit_dir.join(filename);

        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&file_path)?;

        let json = serde_json::to_string(event)?;
        writeln!(file, "{json}")?;

        Ok(())
    }

    /// Returns all events from a specific session, across all audit files.
    pub fn get_by_session(&self, session_id: &str) -> Result<Vec<AuditEvent>, AuditError> {
        let (events, _malformed) = self.read_all_events()?;
        Ok(events
            .into_iter()
            .filter(|e| e.session_id == session_id)
            .collect())
    }

    /// Returns all events from a specific agent, across all audit files.
    pub fn get_by_agent(&self, agent_id: &str) -> Result<Vec<AuditEvent>, AuditError> {
        let (events, _malformed) = self.read_all_events()?;
        Ok(events
            .into_iter()
            .filter(|e| e.agent_id == agent_id)
            .collect())
    }

    /// Returns all events of a specific type, across all audit files.
    pub fn get_by_event_type(
        &self,
        event_type: &AuditEventType,
    ) -> Result<Vec<AuditEvent>, AuditError> {
        let (events, _malformed) = self.read_all_events()?;
        Ok(events
            .into_iter()
            .filter(|e| &e.event_type == event_type)
            .collect())
    }

    /// Returns all events tied to a specific issue reference (e.g.,
    /// `"PROJ-167"`), across all audit files. Events with no
    /// `issue_ref` are excluded — the filter is exact-match against
    /// `Some(issue_ref)`.
    ///
    /// Architecture Section 8.3 lists `getByIssue` as part of the
    /// `AuditStore` interface; this method implements it.
    pub fn get_by_issue(&self, issue_ref: &str) -> Result<Vec<AuditEvent>, AuditError> {
        let (events, _malformed) = self.read_all_events()?;
        Ok(events
            .into_iter()
            .filter(|e| e.issue_ref.as_deref() == Some(issue_ref))
            .collect())
    }

    /// Returns the most recent `limit` events, newest first, across all
    /// audit files.
    ///
    /// Events are stored chronologically (by day-file name, then append
    /// order within a file), so "most recent" is the tail of the full
    /// history; this reverses that tail so the newest event is first —
    /// the order an audit viewer wants to show. A `limit` of 0 returns an
    /// empty list. Malformed lines are skipped (see `read_all_events`).
    pub fn get_recent(&self, limit: usize) -> Result<Vec<AuditEvent>, AuditError> {
        let (mut events, _malformed) = self.read_all_events()?;
        // Keep only the last `limit` in chronological order, then reverse
        // so the newest event leads.
        let start = events.len().saturating_sub(limit);
        let recent = events.split_off(start);
        Ok(recent.into_iter().rev().collect())
    }

    /// Returns the list of malformed JSONL lines encountered when
    /// reading the audit history. Each record carries the file path,
    /// 1-indexed line number, and parse-error string so callers (audit
    /// viewer, hook layer, tests) can surface or count corruption
    /// deliberately rather than silently absorbing it.
    ///
    /// Empty result means the on-disk audit history was clean as of
    /// the call. The same lines are reported on every call — there is
    /// no de-duplication or rate-limiting; the caller decides what to
    /// do with the information.
    pub fn corruption_report(&self) -> Result<Vec<MalformedLine>, AuditError> {
        let (_events, malformed) = self.read_all_events()?;
        Ok(malformed)
    }

    /// Reads all JSONL files in the audit directory, sorted by filename
    /// (which sorts chronologically due to YYYY-MM-DD naming), and
    /// deserialises every line into an AuditEvent.
    ///
    /// Returns the events in chronological-by-filename order plus a
    /// list of malformed lines that were skipped. Audit data is
    /// forensic, so a single corrupt line (partial write at crash,
    /// disk corruption, manual edit, mixed-version schema) is reported
    /// rather than aborting the whole query — JSONL is designed to
    /// tolerate per-line failures. The `MalformedLine` records carry
    /// enough context (file path, 1-indexed line number, parse error)
    /// for the caller to surface corruption to a human; the raw line
    /// content is deliberately not captured to avoid leaking tampered
    /// payloads.
    ///
    /// TODO(phase-4): this read path scans every JSONL file and holds
    /// the full deserialised history in memory. Acceptable while audit
    /// volume is bounded (Phase 1 expects on the order of tens of MB).
    /// SqliteAuditStore — the Phase 4 upgrade per architecture Section
    /// 8.4 — replaces this with indexed queries and is the planned
    /// answer to the scaling concern, not an in-place optimisation
    /// here.
    fn read_all_events(&self) -> Result<(Vec<AuditEvent>, Vec<MalformedLine>), AuditError> {
        let mut files: Vec<PathBuf> = fs::read_dir(&self.audit_dir)?
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.path())
            .filter(|path| path.extension().map(|ext| ext == "jsonl").unwrap_or(false))
            .collect();

        // Sort by filename for chronological order.
        files.sort();

        let mut events = Vec::new();
        let mut malformed = Vec::new();
        for file_path in files {
            let file = fs::File::open(&file_path)?;
            let reader = BufReader::new(file);

            for (line_index, line) in reader.lines().enumerate() {
                let line = line?;
                if line.trim().is_empty() {
                    continue;
                }
                match serde_json::from_str::<AuditEvent>(&line) {
                    Ok(event) => events.push(event),
                    Err(err) => {
                        malformed.push(MalformedLine {
                            file: file_path.clone(),
                            // line_index is 0-indexed; user-facing
                            // convention is 1-indexed.
                            line_number: line_index + 1,
                            error: err.to_string(),
                        });
                    }
                }
            }
        }

        Ok((events, malformed))
    }
}

#[cfg(test)]
mod tests {
    use super::super::schema::AuditResult;
    use super::*;

    /// Helper to create a test audit event with configurable fields.
    fn test_event(
        id: &str,
        session_id: &str,
        agent_id: &str,
        event_type: AuditEventType,
    ) -> AuditEvent {
        AuditEvent {
            id: id.to_string(),
            timestamp: "2026-02-25T12:00:00Z".to_string(),
            project_id: "test-project".to_string(),
            agent_id: agent_id.to_string(),
            agent_role: "code-agent".to_string(),
            delegation_chain: vec!["human:kevin".to_string()],
            event_type,
            action: format!("Test action for {id}"),
            details: serde_json::json!({"test": true}),
            issue_ref: None,
            initiative_ref: None,
            session_id: session_id.to_string(),
            result: AuditResult::Success,
            reason: None,
        }
    }

    #[test]
    fn test_log_creates_file_and_appends_event() {
        let tmp = tempfile::tempdir().unwrap();
        let store = FileSystemAuditStore::new(tmp.path()).unwrap();
        let event = test_event("evt-1", "session-1", "agent-1", AuditEventType::ToolInvoked);

        store.log(&event).unwrap();

        // Verify the audit directory contains exactly one .jsonl file.
        let files: Vec<_> = fs::read_dir(tmp.path().join(".sdlc").join("audit"))
            .unwrap()
            .filter_map(|e| e.ok())
            .collect();
        assert_eq!(files.len(), 1);

        // Verify the file name matches today's date.
        let filename = files[0].file_name().to_string_lossy().to_string();
        let today = Utc::now().format("%Y-%m-%d").to_string();
        assert_eq!(filename, format!("{today}.jsonl"));

        // Verify the event can be read back.
        let events = store.get_by_session("session-1").unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].id, "evt-1");
    }

    #[test]
    fn test_log_multiple_events_preserves_order() {
        let tmp = tempfile::tempdir().unwrap();
        let store = FileSystemAuditStore::new(tmp.path()).unwrap();

        for i in 0..3 {
            let event = test_event(
                &format!("evt-{i}"),
                "session-1",
                "agent-1",
                AuditEventType::ToolInvoked,
            );
            store.log(&event).unwrap();
        }

        let events = store.get_by_session("session-1").unwrap();
        assert_eq!(events.len(), 3);
        assert_eq!(events[0].id, "evt-0");
        assert_eq!(events[1].id, "evt-1");
        assert_eq!(events[2].id, "evt-2");
    }

    #[test]
    fn test_get_by_session_filters_correctly() {
        let tmp = tempfile::tempdir().unwrap();
        let store = FileSystemAuditStore::new(tmp.path()).unwrap();

        store
            .log(&test_event(
                "evt-a1",
                "session-a",
                "agent-1",
                AuditEventType::ToolInvoked,
            ))
            .unwrap();
        store
            .log(&test_event(
                "evt-b1",
                "session-b",
                "agent-1",
                AuditEventType::FileWrite,
            ))
            .unwrap();
        store
            .log(&test_event(
                "evt-a2",
                "session-a",
                "agent-1",
                AuditEventType::ToolCompleted,
            ))
            .unwrap();

        let session_a = store.get_by_session("session-a").unwrap();
        assert_eq!(session_a.len(), 2);
        assert_eq!(session_a[0].id, "evt-a1");
        assert_eq!(session_a[1].id, "evt-a2");

        let session_b = store.get_by_session("session-b").unwrap();
        assert_eq!(session_b.len(), 1);
        assert_eq!(session_b[0].id, "evt-b1");
    }

    #[test]
    fn test_get_by_agent_filters_correctly() {
        let tmp = tempfile::tempdir().unwrap();
        let store = FileSystemAuditStore::new(tmp.path()).unwrap();

        store
            .log(&test_event(
                "evt-1",
                "session-1",
                "agent:code:auth",
                AuditEventType::FileRead,
            ))
            .unwrap();
        store
            .log(&test_event(
                "evt-2",
                "session-1",
                "agent:test:auth",
                AuditEventType::ToolInvoked,
            ))
            .unwrap();
        store
            .log(&test_event(
                "evt-3",
                "session-1",
                "agent:code:auth",
                AuditEventType::FileWrite,
            ))
            .unwrap();

        let code_agent = store.get_by_agent("agent:code:auth").unwrap();
        assert_eq!(code_agent.len(), 2);
        assert_eq!(code_agent[0].id, "evt-1");
        assert_eq!(code_agent[1].id, "evt-3");
    }

    #[test]
    fn test_get_by_event_type_filters_correctly() {
        let tmp = tempfile::tempdir().unwrap();
        let store = FileSystemAuditStore::new(tmp.path()).unwrap();

        store
            .log(&test_event(
                "evt-1",
                "session-1",
                "agent-1",
                AuditEventType::ScopeViolation,
            ))
            .unwrap();
        store
            .log(&test_event(
                "evt-2",
                "session-1",
                "agent-1",
                AuditEventType::ToolInvoked,
            ))
            .unwrap();
        store
            .log(&test_event(
                "evt-3",
                "session-1",
                "agent-1",
                AuditEventType::ScopeViolation,
            ))
            .unwrap();

        let violations = store
            .get_by_event_type(&AuditEventType::ScopeViolation)
            .unwrap();
        assert_eq!(violations.len(), 2);
        assert_eq!(violations[0].id, "evt-1");
        assert_eq!(violations[1].id, "evt-3");
    }

    #[test]
    fn test_get_by_issue_filters_to_matching_issue_ref() {
        let tmp = tempfile::tempdir().unwrap();
        let store = FileSystemAuditStore::new(tmp.path()).unwrap();

        let mut event_a = test_event(
            "evt-a",
            "session-1",
            "agent-1",
            AuditEventType::FileWrite,
        );
        event_a.issue_ref = Some("PROJ-167".to_string());

        let mut event_b = test_event(
            "evt-b",
            "session-1",
            "agent-1",
            AuditEventType::FileWrite,
        );
        event_b.issue_ref = Some("PROJ-200".to_string());

        let mut event_c = test_event(
            "evt-c",
            "session-1",
            "agent-1",
            AuditEventType::FileWrite,
        );
        event_c.issue_ref = Some("PROJ-167".to_string());

        store.log(&event_a).unwrap();
        store.log(&event_b).unwrap();
        store.log(&event_c).unwrap();

        let proj_167 = store.get_by_issue("PROJ-167").unwrap();
        assert_eq!(proj_167.len(), 2);
        assert_eq!(proj_167[0].id, "evt-a");
        assert_eq!(proj_167[1].id, "evt-c");

        let proj_200 = store.get_by_issue("PROJ-200").unwrap();
        assert_eq!(proj_200.len(), 1);
        assert_eq!(proj_200[0].id, "evt-b");
    }

    #[test]
    fn test_get_by_issue_excludes_events_with_no_issue_ref() {
        let tmp = tempfile::tempdir().unwrap();
        let store = FileSystemAuditStore::new(tmp.path()).unwrap();

        // test_event sets issue_ref to None by default.
        store
            .log(&test_event(
                "evt-no-issue",
                "session-1",
                "agent-1",
                AuditEventType::FileWrite,
            ))
            .unwrap();

        let mut event_with_issue = test_event(
            "evt-with-issue",
            "session-1",
            "agent-1",
            AuditEventType::FileWrite,
        );
        event_with_issue.issue_ref = Some("PROJ-167".to_string());
        store.log(&event_with_issue).unwrap();

        let results = store.get_by_issue("PROJ-167").unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].id, "evt-with-issue");

        // An empty issue_ref string should not match the None event.
        let empty = store.get_by_issue("").unwrap();
        assert!(empty.is_empty());
    }

    #[test]
    fn test_read_all_events_skips_malformed_jsonl_lines() {
        let tmp = tempfile::tempdir().unwrap();
        let store = FileSystemAuditStore::new(tmp.path()).unwrap();

        // Write one valid event so the file exists.
        store
            .log(&test_event(
                "evt-valid-1",
                "session-1",
                "agent-1",
                AuditEventType::FileWrite,
            ))
            .unwrap();

        // Append a malformed line and another valid event directly to
        // today's file. The malformed line is bracketed by valid events
        // so we can verify the iteration recovers.
        let today_filename = format!("{}.jsonl", Utc::now().format("%Y-%m-%d"));
        let today_path = tmp.path().join(".sdlc").join("audit").join(&today_filename);

        let event_after = test_event(
            "evt-valid-2",
            "session-1",
            "agent-1",
            AuditEventType::FileWrite,
        );
        let valid_after_json = serde_json::to_string(&event_after).unwrap();

        let mut file = OpenOptions::new()
            .append(true)
            .open(&today_path)
            .unwrap();
        writeln!(file, "{{this is not valid json").unwrap();
        writeln!(file, "{valid_after_json}").unwrap();
        drop(file);

        // The query must succeed, returning the two valid events and
        // skipping the malformed line. A pre-fix version of the store
        // would propagate the serde error and return Err.
        let events = store.get_by_session("session-1").unwrap();
        assert_eq!(events.len(), 2, "expected two valid events, malformed line skipped");
        assert_eq!(events[0].id, "evt-valid-1");
        assert_eq!(events[1].id, "evt-valid-2");

        // The corruption_report API surfaces the skipped line to
        // callers so they can act on it (e.g., audit viewer UI flag,
        // structured logging when it lands). The previous evt-valid-1
        // is on line 1; the malformed line is line 2.
        let report = store.corruption_report().unwrap();
        assert_eq!(report.len(), 1, "expected exactly one malformed line");
        assert_eq!(report[0].line_number, 2);
        assert_eq!(report[0].file, today_path);
        // The error message must not be empty — we want a diagnostic
        // string available to callers — but we don't pin its exact
        // contents because serde_json's wording can change.
        assert!(
            !report[0].error.is_empty(),
            "expected a non-empty parse-error message"
        );
    }

    #[test]
    fn test_corruption_report_is_empty_when_audit_history_is_clean() {
        let tmp = tempfile::tempdir().unwrap();
        let store = FileSystemAuditStore::new(tmp.path()).unwrap();

        // No events logged — reading an empty audit dir yields no
        // events and no malformed lines.
        assert!(store.corruption_report().unwrap().is_empty());

        // After well-formed writes the corruption report stays empty.
        store
            .log(&test_event(
                "evt-1",
                "session-1",
                "agent-1",
                AuditEventType::FileWrite,
            ))
            .unwrap();
        store
            .log(&test_event(
                "evt-2",
                "session-1",
                "agent-1",
                AuditEventType::FileWrite,
            ))
            .unwrap();

        assert!(store.corruption_report().unwrap().is_empty());
    }

    #[test]
    fn test_event_serialization_round_trip() {
        let event = AuditEvent {
            id: "evt-rt".to_string(),
            timestamp: "2026-02-25T12:00:00Z".to_string(),
            project_id: "proj-1".to_string(),
            agent_id: "agent:code:auth-module:sprint-42".to_string(),
            agent_role: "code-agent".to_string(),
            delegation_chain: vec![
                "human:kevin".to_string(),
                "agent:pm-coordinator:proj-100".to_string(),
            ],
            event_type: AuditEventType::ScopeViolation,
            action: "Attempted write to /config/secrets.env".to_string(),
            details: serde_json::json!({
                "file": "/config/secrets.env",
                "scope": ["src/**", "tests/**"]
            }),
            issue_ref: Some("PROJ-167".to_string()),
            initiative_ref: Some("PROJ-100".to_string()),
            session_id: "session-xyz".to_string(),
            result: AuditResult::Blocked,
            reason: Some("File not in agent scope: [src/**, tests/**]".to_string()),
        };

        // Serialize to JSON line.
        let json = serde_json::to_string(&event).unwrap();

        // Deserialize back.
        let parsed: AuditEvent = serde_json::from_str(&json).unwrap();

        assert_eq!(parsed.id, event.id);
        assert_eq!(parsed.agent_id, event.agent_id);
        assert_eq!(parsed.event_type, event.event_type);
        assert_eq!(parsed.result, event.result);
        assert_eq!(parsed.reason, event.reason);
        assert_eq!(parsed.delegation_chain.len(), 2);
        assert_eq!(parsed.issue_ref, Some("PROJ-167".to_string()));
        assert_eq!(parsed.initiative_ref, Some("PROJ-100".to_string()));
    }
}
