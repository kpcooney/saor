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

use super::schema::{AuditError, AuditEvent, AuditEventType};

/// Append-only JSONL audit store. Writes events to per-day files under
/// `{project_path}/.sdlc/audit/` following the granularity strategy
/// from ADR-001.
///
/// Each call to `log()` appends a single JSON line to today's file.
/// Query methods read all files and filter in memory — acceptable for
/// Phase 1 scale.
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
    /// line — no multi-line records. The file is opened in append mode
    /// so concurrent calls within the same process are safe (though
    /// Phase 1 runs a single agent at a time).
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
        let events = self.read_all_events()?;
        Ok(events
            .into_iter()
            .filter(|e| e.session_id == session_id)
            .collect())
    }

    /// Returns all events from a specific agent, across all audit files.
    pub fn get_by_agent(&self, agent_id: &str) -> Result<Vec<AuditEvent>, AuditError> {
        let events = self.read_all_events()?;
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
        let events = self.read_all_events()?;
        Ok(events
            .into_iter()
            .filter(|e| &e.event_type == event_type)
            .collect())
    }

    /// Reads all JSONL files in the audit directory, sorted by filename
    /// (which sorts chronologically due to YYYY-MM-DD naming), and
    /// deserializes every line into an AuditEvent.
    fn read_all_events(&self) -> Result<Vec<AuditEvent>, AuditError> {
        let mut files: Vec<PathBuf> = fs::read_dir(&self.audit_dir)?
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.path())
            .filter(|path| path.extension().map(|ext| ext == "jsonl").unwrap_or(false))
            .collect();

        // Sort by filename for chronological order.
        files.sort();

        let mut events = Vec::new();
        for file_path in files {
            let file = fs::File::open(&file_path)?;
            let reader = BufReader::new(file);

            for line in reader.lines() {
                let line = line?;
                if line.trim().is_empty() {
                    continue;
                }
                let event: AuditEvent = serde_json::from_str(&line)?;
                events.push(event);
            }
        }

        Ok(events)
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
