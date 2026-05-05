// audit/schema.rs
//
// Rust types for audit events. The AuditEvent struct mirrors the TypeScript
// AuditEvent interface defined in agents/src/hooks/audit-logger.ts and must
// be kept in sync manually. Both are serialized to/from JSON at the IPC
// boundary.
//
// AuditEventType is an exhaustive enum covering lifecycle events
// (agent.created, agent.completed), action events (tool.invoked,
// file.write), decision events (decision.routing, handoff.initiated),
// and security events (scope.violation, credential.expired).
//
// See docs/architecture/sdlc-agent-architecture-research-v4.md Section 8.2
// for the full event schema with field-level documentation.

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Errors that can occur in audit store operations.
#[derive(Debug, Error)]
pub enum AuditError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),

    #[error("serialization error: {0}")]
    Serialization(#[from] serde_json::Error),

    #[error("failed to create audit directory: {0}")]
    DirectoryCreation(String),
}

/// Record of a JSONL line that could not be deserialised into an
/// AuditEvent — partial write at crash, manual edit, mixed-version
/// schema. The audit store's read path log-and-skips these so a single
/// bad line doesn't abort the whole query, but the records are
/// returned alongside the events so callers (audit viewer UI, hook
/// layer, tests) can surface or count corruption deliberately.
#[derive(Debug, Clone, PartialEq)]
pub struct MalformedLine {
    /// Path to the JSONL file containing the malformed line.
    pub file: std::path::PathBuf,

    /// 1-indexed line number within the file (user-facing convention).
    pub line_number: usize,

    /// `serde_json::Error::Display` for diagnostics. The raw line
    /// content is intentionally not captured here — a tampered file
    /// could otherwise leak content via this string.
    pub error: String,
}

/// Exhaustive set of audit event types. Each variant maps to a dot-notation
/// string (e.g., `AgentCreated` serializes to `"agent.created"`) for
/// consistency with the TypeScript interface.
///
/// Categories:
/// - Lifecycle: agent creation, completion, failure, expiration
/// - Actions: tool invocations, file operations, issue tracking, memory access
/// - Decisions: routing, approvals, rejections, handoffs
/// - Security: scope violations, credential expiry, auth failures
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum AuditEventType {
    // Lifecycle events
    #[serde(rename = "agent.created")]
    AgentCreated,
    #[serde(rename = "agent.completed")]
    AgentCompleted,
    #[serde(rename = "agent.failed")]
    AgentFailed,
    #[serde(rename = "agent.expired")]
    AgentExpired,

    // Action events
    #[serde(rename = "tool.invoked")]
    ToolInvoked,
    #[serde(rename = "tool.completed")]
    ToolCompleted,
    #[serde(rename = "tool.blocked")]
    ToolBlocked,
    #[serde(rename = "file.read")]
    FileRead,
    #[serde(rename = "file.write")]
    FileWrite,
    #[serde(rename = "file.delete")]
    FileDelete,
    #[serde(rename = "issue.created")]
    IssueCreated,
    #[serde(rename = "issue.updated")]
    IssueUpdated,
    #[serde(rename = "issue.closed")]
    IssueClosed,
    #[serde(rename = "memory.read")]
    MemoryRead,
    #[serde(rename = "memory.write")]
    MemoryWrite,

    // Decision events
    #[serde(rename = "decision.routing")]
    DecisionRouting,
    #[serde(rename = "decision.approval")]
    DecisionApproval,
    #[serde(rename = "decision.rejection")]
    DecisionRejection,
    #[serde(rename = "handoff.initiated")]
    HandoffInitiated,
    #[serde(rename = "handoff.completed")]
    HandoffCompleted,

    // Security events
    #[serde(rename = "scope.violation")]
    ScopeViolation,
    #[serde(rename = "credential.expired")]
    CredentialExpired,
    #[serde(rename = "auth.failed")]
    AuthFailed,
}

/// Outcome of an audited action.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AuditResult {
    Success,
    Failure,
    Blocked,
    Pending,
}

/// A single audit event capturing an agent action, decision, or lifecycle
/// transition. Every field uses camelCase serialization to match the
/// TypeScript interface.
///
/// The audit trail is append-only — events are never modified or deleted.
/// They are written automatically by hooks (PostToolUse, PreToolUse) and
/// queried by the audit viewer UI and by agents (e.g., Documentation
/// Specialist generating changelogs).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEvent {
    /// Unique event identifier (UUID v4).
    pub id: String,

    /// ISO 8601 timestamp of when the event occurred.
    pub timestamp: String,

    /// Project this event belongs to.
    pub project_id: String,

    /// Identity ID of the agent that performed the action.
    pub agent_id: String,

    /// Role of the agent (e.g., "code-agent", "pm-coordinator").
    pub agent_role: String,

    /// Full delegation chain from this agent back to the human.
    pub delegation_chain: Vec<String>,

    /// Type of event — categorizes what happened.
    pub event_type: AuditEventType,

    /// Human-readable description of the action.
    pub action: String,

    /// Structured details — tool parameters, file paths, metadata.
    pub details: serde_json::Value,

    /// Issue tracker reference (e.g., "PROJ-167"). Optional.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub issue_ref: Option<String>,

    /// Initiative tracker reference (e.g., "PROJ-100"). Optional.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub initiative_ref: Option<String>,

    /// Claude SDK session ID for grouping events from the same session.
    pub session_id: String,

    /// Outcome of the action.
    pub result: AuditResult,

    /// Explanation, especially for blocked or failed actions. Optional.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_event_type_serializes_to_dot_notation() {
        assert_eq!(
            serde_json::to_string(&AuditEventType::AgentCreated).unwrap(),
            "\"agent.created\""
        );
        assert_eq!(
            serde_json::to_string(&AuditEventType::ToolBlocked).unwrap(),
            "\"tool.blocked\""
        );
        assert_eq!(
            serde_json::to_string(&AuditEventType::ScopeViolation).unwrap(),
            "\"scope.violation\""
        );
        assert_eq!(
            serde_json::to_string(&AuditEventType::HandoffCompleted).unwrap(),
            "\"handoff.completed\""
        );
    }

    #[test]
    fn test_event_type_deserializes_from_dot_notation() {
        let parsed: AuditEventType = serde_json::from_str("\"tool.invoked\"").unwrap();
        assert_eq!(parsed, AuditEventType::ToolInvoked);

        let parsed: AuditEventType = serde_json::from_str("\"scope.violation\"").unwrap();
        assert_eq!(parsed, AuditEventType::ScopeViolation);
    }

    #[test]
    fn test_audit_result_serializes_to_lowercase() {
        assert_eq!(
            serde_json::to_string(&AuditResult::Success).unwrap(),
            "\"success\""
        );
        assert_eq!(
            serde_json::to_string(&AuditResult::Blocked).unwrap(),
            "\"blocked\""
        );
    }

    #[test]
    fn test_audit_event_uses_camel_case_field_names() {
        let event = AuditEvent {
            id: "evt-001".to_string(),
            timestamp: "2026-02-25T12:00:00Z".to_string(),
            project_id: "proj-1".to_string(),
            agent_id: "agent:code:auth".to_string(),
            agent_role: "code-agent".to_string(),
            delegation_chain: vec!["human:kevin".to_string()],
            event_type: AuditEventType::ToolInvoked,
            action: "Read file src/main.rs".to_string(),
            details: serde_json::json!({"path": "src/main.rs"}),
            issue_ref: Some("PROJ-167".to_string()),
            initiative_ref: None,
            session_id: "session-abc".to_string(),
            result: AuditResult::Success,
            reason: None,
        };

        let json = serde_json::to_string(&event).unwrap();

        // Verify camelCase field names.
        assert!(json.contains("\"projectId\""));
        assert!(json.contains("\"agentId\""));
        assert!(json.contains("\"agentRole\""));
        assert!(json.contains("\"delegationChain\""));
        assert!(json.contains("\"eventType\""));
        assert!(json.contains("\"issueRef\""));
        assert!(json.contains("\"sessionId\""));

        // Verify dot-notation event type.
        assert!(json.contains("\"tool.invoked\""));

        // Verify optional None fields are omitted.
        assert!(!json.contains("\"initiativeRef\""));
        assert!(!json.contains("\"reason\""));
    }
}
