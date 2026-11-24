// bridge/protocol.rs
//
// Wire types for the storage bridge (ADR-009). Every protocol line is one JSON
// object carrying a `kind` discriminator:
//
//   request  (sidecar → Rust)  { kind, id, method, params }
//   response (Rust → sidecar)  { kind, id, ok: true,  result }
//                              { kind, id, ok: false, error: { code, message } }
//   status   (sidecar → Rust)  { kind, status, error? }
//
// Field names are camelCase in both directions. These types mirror
// agents/src/bridge/protocol.ts and are kept in sync by hand; the cross-process
// test in src-tauri/tests/storage_bridge.rs fails if the two drift.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::memory::{MemoryCategory, MemoryEntry};

/// `kind` of a request line written by the sidecar.
pub const KIND_REQUEST: &str = "request";
/// `kind` of a response line written back to the sidecar.
pub const KIND_RESPONSE: &str = "response";
/// `kind` of a lifecycle status line written by the sidecar.
pub const KIND_STATUS: &str = "status";

/// Keyword-search the project's memory.
pub const METHOD_MEMORY_SEARCH: &str = "memory.search";
/// Persist one memory entry.
pub const METHOD_MEMORY_WRITE: &str = "memory.write";
/// List the most recent entries of one category.
pub const METHOD_MEMORY_RECENT: &str = "memory.recent";
/// Append one event to the audit trail.
pub const METHOD_AUDIT_LOG: &str = "audit.log";
/// Dereference one reference-manifest URI.
pub const METHOD_REFERENCE_RESOLVE: &str = "reference.resolve";
/// Append one entry to the session's transcript.
pub const METHOD_TRANSCRIPT_APPEND: &str = "transcript.append";

/// A parsed request line. `params` defaults to `null` when omitted, so a
/// method with no parameters need not send the field.
#[derive(Debug, Deserialize)]
pub struct BridgeRequest {
    /// Correlation id chosen by the sidecar; echoed on the response.
    pub id: u64,
    /// Dotted method name, e.g. `memory.write`.
    pub method: String,
    /// Method-specific parameters.
    #[serde(default)]
    pub params: Value,
}

/// Machine-readable category of a bridge failure, so the TypeScript side can
/// tell a caller mistake from a store failure without parsing the message.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BridgeErrorCode {
    /// The line had `kind: "request"` but was not a well-formed request.
    InvalidRequest,
    /// The method name is not one the bridge serves.
    UnknownMethod,
    /// The params did not match the method's expected shape.
    InvalidParams,
    /// The request named a project or session other than the one this bridge
    /// is bound to.
    ScopeMismatch,
    /// The memory or audit store failed.
    StoreError,
    /// The reference resolver refused or failed to resolve the URI.
    ResolveError,
}

/// A failed request: the code plus a human-readable message that reaches the
/// agent as the tool's error text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BridgeError {
    pub code: BridgeErrorCode,
    pub message: String,
}

impl BridgeError {
    pub fn new(code: BridgeErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

/// Serializes a successful response line (without the trailing newline).
pub fn success_line(id: u64, result: Value) -> String {
    json!({ "kind": KIND_RESPONSE, "id": id, "ok": true, "result": result }).to_string()
}

/// Serializes a failed response line (without the trailing newline). `id` is
/// `None` only when the request was too malformed to carry one; the sidecar
/// cannot correlate such a response and reports it to stderr.
pub fn error_line(id: Option<u64>, error: &BridgeError) -> String {
    json!({
        "kind": KIND_RESPONSE,
        "id": id,
        "ok": false,
        "error": { "code": error.code, "message": error.message },
    })
    .to_string()
}

/// A lifecycle status line from the sidecar: `started`, `completed`, `failed`,
/// or `stopped`. Unknown extra fields are ignored. `error` carries the failure
/// message on a `failed` status, which Rust records as the `agent.failed`
/// audit event's reason.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct SidecarStatus {
    pub status: String,
    #[serde(default)]
    pub error: Option<String>,
}

/// A memory entry as it crosses the bridge: the same fields as [`MemoryEntry`],
/// in the camelCase the TypeScript `MemoryEntry` interface uses.
///
/// `MemoryEntry` itself serializes snake_case, which the frontend's IPC
/// commands depend on, so the bridge converts at its boundary rather than
/// changing that.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireMemoryEntry {
    pub id: String,
    pub project_id: String,
    pub category: MemoryCategory,
    pub content: String,
    #[serde(default)]
    pub metadata: Value,
    pub created_by: String,
    pub created_at: String,
    pub weight: f64,
}

impl From<MemoryEntry> for WireMemoryEntry {
    fn from(entry: MemoryEntry) -> Self {
        Self {
            id: entry.id,
            project_id: entry.project_id,
            category: entry.category,
            content: entry.content,
            metadata: entry.metadata,
            created_by: entry.created_by,
            created_at: entry.created_at,
            weight: entry.weight,
        }
    }
}

impl From<WireMemoryEntry> for MemoryEntry {
    fn from(entry: WireMemoryEntry) -> Self {
        Self {
            id: entry.id,
            project_id: entry.project_id,
            category: entry.category,
            content: entry.content,
            metadata: entry.metadata,
            created_by: entry.created_by,
            created_at: entry.created_at,
            weight: entry.weight,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_wire_memory_entry_uses_camel_case_field_names() {
        let entry = WireMemoryEntry {
            id: "e1".to_string(),
            project_id: "p1".to_string(),
            category: MemoryCategory::Learning,
            content: "c".to_string(),
            metadata: json!({}),
            created_by: "agent:x".to_string(),
            created_at: "2026-11-23T00:00:00Z".to_string(),
            weight: 1.0,
        };
        let value = serde_json::to_value(&entry).unwrap();
        assert_eq!(value["projectId"], "p1");
        assert_eq!(value["createdBy"], "agent:x");
        assert_eq!(value["createdAt"], "2026-11-23T00:00:00Z");
        assert_eq!(value["category"], "learning");
        // Negative control: the snake_case names are not emitted.
        assert!(value.get("project_id").is_none());
    }

    #[test]
    fn test_error_line_carries_snake_case_code_and_null_id_when_uncorrelated() {
        let error = BridgeError::new(BridgeErrorCode::ScopeMismatch, "wrong project");
        let with_id: Value = serde_json::from_str(&error_line(Some(3), &error)).unwrap();
        assert_eq!(with_id["kind"], "response");
        assert_eq!(with_id["id"], 3);
        assert_eq!(with_id["ok"], false);
        assert_eq!(with_id["error"]["code"], "scope_mismatch");
        assert_eq!(with_id["error"]["message"], "wrong project");

        let without_id: Value = serde_json::from_str(&error_line(None, &error)).unwrap();
        assert!(without_id["id"].is_null());
    }
}
