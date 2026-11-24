// bridge/host.rs
//
// BridgeHost — the Rust end of the storage bridge (ADR-009). It is bound to the
// one agent session it was created for and services that sidecar's request
// lines against the session's project stores: the SQLite memory store, the
// JSONL audit store, the reference resolver, and the session's transcript.
//
// `handle_line` is the whole surface: one line of sidecar stdout in, and either
// a response line to write back to the sidecar's stdin, a parsed status line,
// or nothing (the line was not a protocol line). It never panics and never
// returns an error — a bad request becomes an error *response*, so one
// malformed line cannot take the bridge down.
//
// Session binding: a `memory.write` or `audit.log` naming a different project,
// or an `audit.log` naming a different session, is refused with
// `scope_mismatch`. The sidecar cannot write into another project's stores or
// attribute events to another session, whatever it sends. A
// `transcript.append` carries no session at all: the entry is filed under the
// bound session, so there is nothing for the sidecar to get wrong.
//
// Stores are opened per request, the same way the IPC commands do it (see
// commands/memory.rs). That keeps the host free of long-lived connections and
// lets the UI's own commands read and write the same files between requests.

use std::path::{Path, PathBuf};

use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::audit::{AuditEvent, FileSystemAuditStore};
use crate::memory::{MemoryCategory, MemoryEntry, SqliteMemoryStore};
use crate::references::{resolve_ref, ResolvedReference};
use crate::transcript::{FileSystemTranscriptStore, TranscriptEntry, TranscriptEntryKind};

use super::protocol::{
    error_line, success_line, BridgeError, BridgeErrorCode, BridgeRequest, SidecarStatus,
    WireMemoryEntry, KIND_REQUEST, KIND_STATUS, METHOD_AUDIT_LOG, METHOD_MEMORY_RECENT,
    METHOD_MEMORY_SEARCH, METHOD_MEMORY_WRITE, METHOD_REFERENCE_RESOLVE, METHOD_TRANSCRIPT_APPEND,
};

/// Results returned by `memory.search` when the request gives no limit.
const DEFAULT_SEARCH_LIMIT: i64 = 20;
/// Results returned by `memory.recent` when the request gives no limit.
const DEFAULT_RECENT_LIMIT: i64 = 10;
/// Upper bound on entries returned by one memory request, so a single response
/// line stays bounded whatever the sidecar asks for.
const MAX_MEMORY_LIMIT: i64 = 100;

/// What the caller should do with one line of sidecar stdout.
#[derive(Debug, PartialEq)]
pub enum LineOutcome {
    /// A request was serviced (or refused): write this line, plus a newline,
    /// to the sidecar's stdin.
    Response(String),
    /// The sidecar reported a lifecycle status.
    Status(SidecarStatus),
    /// Not a protocol line — stray output, to be dropped.
    Ignored,
}

/// Services storage requests for one agent session.
pub struct BridgeHost {
    session_id: String,
    project_id: String,
    project_path: PathBuf,
    standards_root: PathBuf,
}

impl BridgeHost {
    /// Creates a host bound to `session_id` and to the project `project_id`
    /// rooted at `project_path`. `standards_root` is the system-default
    /// standards directory — the base tier that `standards://` references fall
    /// back to when the project has no override.
    pub fn new(
        session_id: &str,
        project_id: &str,
        project_path: &Path,
        standards_root: &Path,
    ) -> Self {
        Self {
            session_id: session_id.to_string(),
            project_id: project_id.to_string(),
            project_path: project_path.to_path_buf(),
            standards_root: standards_root.to_path_buf(),
        }
    }

    /// Handles one line of sidecar stdout. See [`LineOutcome`].
    ///
    /// Anything that is not a JSON object with a known `kind` is ignored, so
    /// stray output on the sidecar's stdout cannot corrupt the channel.
    pub fn handle_line(&self, line: &str) -> LineOutcome {
        let Ok(Value::Object(object)) = serde_json::from_str::<Value>(line.trim()) else {
            return LineOutcome::Ignored;
        };
        let value = Value::Object(object);

        match value.get("kind").and_then(Value::as_str) {
            Some(KIND_REQUEST) => LineOutcome::Response(self.handle_request(value)),
            Some(KIND_STATUS) => match serde_json::from_value::<SidecarStatus>(value) {
                Ok(status) => LineOutcome::Status(status),
                Err(_) => LineOutcome::Ignored,
            },
            _ => LineOutcome::Ignored,
        }
    }

    /// Parses and dispatches a request, returning the response line.
    fn handle_request(&self, value: Value) -> String {
        // Recover the id before the strict parse so a request that is
        // malformed elsewhere still gets a correlated error response.
        let id = value.get("id").and_then(Value::as_u64);

        let request: BridgeRequest = match serde_json::from_value(value) {
            Ok(request) => request,
            Err(e) => {
                return error_line(
                    id,
                    &BridgeError::new(
                        BridgeErrorCode::InvalidRequest,
                        format!("malformed bridge request: {e}"),
                    ),
                );
            }
        };

        match self.dispatch(&request.method, request.params) {
            Ok(result) => success_line(request.id, result),
            Err(error) => error_line(Some(request.id), &error),
        }
    }

    /// Routes a method to its handler.
    fn dispatch(&self, method: &str, params: Value) -> Result<Value, BridgeError> {
        match method {
            METHOD_MEMORY_SEARCH => self.memory_search(parse_params(method, params)?),
            METHOD_MEMORY_WRITE => self.memory_write(parse_params(method, params)?),
            METHOD_MEMORY_RECENT => self.memory_recent(parse_params(method, params)?),
            METHOD_AUDIT_LOG => self.audit_log(parse_params(method, params)?),
            METHOD_REFERENCE_RESOLVE => self.reference_resolve(parse_params(method, params)?),
            METHOD_TRANSCRIPT_APPEND => self.transcript_append(parse_params(method, params)?),
            other => Err(BridgeError::new(
                BridgeErrorCode::UnknownMethod,
                format!("unknown bridge method \"{other}\""),
            )),
        }
    }

    fn memory_search(&self, params: MemorySearchParams) -> Result<Value, BridgeError> {
        let limit = clamp_limit(params.limit, DEFAULT_SEARCH_LIMIT);
        let entries = self
            .open_memory()?
            .search_in_category(&params.query, params.category.as_ref(), limit)
            .map_err(store_error)?;
        Ok(entries_to_value(entries))
    }

    fn memory_write(&self, params: MemoryWriteParams) -> Result<Value, BridgeError> {
        self.require_project(&params.entry.project_id)?;
        let entry: MemoryEntry = params.entry.into();
        self.open_memory()?
            .write_entry(&entry)
            .map_err(store_error)?;
        Ok(Value::Null)
    }

    fn memory_recent(&self, params: MemoryRecentParams) -> Result<Value, BridgeError> {
        let limit = clamp_limit(params.limit, DEFAULT_RECENT_LIMIT);
        let entries = self
            .open_memory()?
            .recent_by_category(&params.category, limit)
            .map_err(store_error)?;
        Ok(entries_to_value(entries))
    }

    fn audit_log(&self, params: AuditLogParams) -> Result<Value, BridgeError> {
        let event = params.event;
        self.require_project(&event.project_id)?;
        if event.session_id != self.session_id {
            return Err(BridgeError::new(
                BridgeErrorCode::ScopeMismatch,
                format!(
                    "audit event names session \"{}\" but this bridge serves session \"{}\"",
                    event.session_id, self.session_id
                ),
            ));
        }
        FileSystemAuditStore::new(&self.project_path)
            .and_then(|store| store.log(&event))
            .map_err(store_error)?;
        Ok(Value::Null)
    }

    fn reference_resolve(&self, params: ReferenceResolveParams) -> Result<Value, BridgeError> {
        let memory = self.open_memory()?;
        let resolved = resolve_ref(
            &params.uri,
            &self.project_path,
            &self.standards_root,
            memory.connection(),
        )
        .map_err(|e| BridgeError::new(BridgeErrorCode::ResolveError, e.to_string()))?;

        // Mirrors the TypeScript `ResolvedReference` discriminated union.
        Ok(match resolved {
            ResolvedReference::Content(content) => {
                json!({ "kind": "content", "uri": params.uri, "content": content })
            }
            ResolvedReference::MemoryEntries(entries) => {
                json!({ "kind": "memory", "uri": params.uri, "entries": entries_to_value(entries) })
            }
        })
    }

    /// Appends one entry to the bound session's transcript. The sidecar sends
    /// the entry without a session; it is always filed under the session this
    /// host serves.
    fn transcript_append(&self, params: TranscriptAppendParams) -> Result<Value, BridgeError> {
        let entry = TranscriptEntry {
            session_id: self.session_id.clone(),
            timestamp: params.entry.timestamp,
            kind: params.entry.kind,
            text: params.entry.text,
            details: params.entry.details,
        };
        FileSystemTranscriptStore::new(&self.project_path)
            .and_then(|store| store.append(&entry))
            .map_err(store_error)?;
        Ok(Value::Null)
    }

    /// Opens the bound project's memory database.
    fn open_memory(&self) -> Result<SqliteMemoryStore, BridgeError> {
        let db_path = self.project_path.join(".sdlc").join("memory.db");
        SqliteMemoryStore::new(&db_path).map_err(store_error)
    }

    /// Refuses a write that names any project other than the bound one.
    fn require_project(&self, project_id: &str) -> Result<(), BridgeError> {
        if project_id == self.project_id {
            return Ok(());
        }
        Err(BridgeError::new(
            BridgeErrorCode::ScopeMismatch,
            format!(
                "request names project \"{project_id}\" but this bridge serves project \"{}\"",
                self.project_id
            ),
        ))
    }
}

#[derive(Deserialize)]
struct MemorySearchParams {
    query: String,
    #[serde(default)]
    category: Option<MemoryCategory>,
    #[serde(default)]
    limit: Option<i64>,
}

#[derive(Deserialize)]
struct MemoryWriteParams {
    entry: WireMemoryEntry,
}

#[derive(Deserialize)]
struct MemoryRecentParams {
    category: MemoryCategory,
    #[serde(default)]
    limit: Option<i64>,
}

#[derive(Deserialize)]
struct AuditLogParams {
    event: AuditEvent,
}

#[derive(Deserialize)]
struct ReferenceResolveParams {
    uri: String,
}

#[derive(Deserialize)]
struct TranscriptAppendParams {
    entry: WireTranscriptEntry,
}

/// A transcript entry as the sidecar sends it: a [`TranscriptEntry`] without
/// the session, which the host supplies. Unknown fields — a `sessionId`
/// included — are ignored.
#[derive(Deserialize)]
struct WireTranscriptEntry {
    timestamp: String,
    kind: TranscriptEntryKind,
    text: String,
    #[serde(default = "empty_details")]
    details: Value,
}

fn empty_details() -> Value {
    json!({})
}

/// Deserializes a method's params, mapping a shape mismatch to `invalid_params`.
fn parse_params<T: DeserializeOwned>(method: &str, params: Value) -> Result<T, BridgeError> {
    serde_json::from_value(params).map_err(|e| {
        BridgeError::new(
            BridgeErrorCode::InvalidParams,
            format!("invalid params for {method}: {e}"),
        )
    })
}

/// Applies the default and clamps into `[0, MAX_MEMORY_LIMIT]`. Negatives are
/// floored to 0 because SQLite reads a negative `LIMIT` as "no limit".
fn clamp_limit(limit: Option<i64>, default: i64) -> i64 {
    limit.unwrap_or(default).clamp(0, MAX_MEMORY_LIMIT)
}

fn entries_to_value(entries: Vec<MemoryEntry>) -> Value {
    let wire: Vec<WireMemoryEntry> = entries.into_iter().map(WireMemoryEntry::from).collect();
    json!(wire)
}

fn store_error(error: impl std::fmt::Display) -> BridgeError {
    BridgeError::new(BridgeErrorCode::StoreError, error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::ProjectRegistry;

    const SESSION: &str = "session-under-test";

    /// A registered temp-dir project with real stores, and a host bound to it.
    struct Fixture {
        host: BridgeHost,
        project_id: String,
        project_path: PathBuf,
        _tmp: tempfile::TempDir,
    }

    fn fixture() -> Fixture {
        let tmp = tempfile::tempdir().unwrap();
        let registry = ProjectRegistry::open_in_memory().unwrap();
        let project_path = tmp.path().join("proj");
        let project = registry.create("Bridge", &project_path, "").unwrap();

        // A system-default standards tree for standards:// resolution.
        let standards_root = tmp.path().join("standards");
        std::fs::create_dir_all(standards_root.join("coding-standards")).unwrap();
        std::fs::write(
            standards_root.join("coding-standards").join("rust.md"),
            "# Rust standard",
        )
        .unwrap();

        Fixture {
            host: BridgeHost::new(SESSION, &project.id, &project_path, &standards_root),
            project_id: project.id,
            project_path,
            _tmp: tmp,
        }
    }

    /// Sends a request and returns the parsed response object.
    fn call(host: &BridgeHost, id: u64, method: &str, params: Value) -> Value {
        let line =
            json!({ "kind": "request", "id": id, "method": method, "params": params }).to_string();
        match host.handle_line(&line) {
            LineOutcome::Response(response) => serde_json::from_str(&response).unwrap(),
            other => panic!("expected a response, got {other:?}"),
        }
    }

    fn entry(project_id: &str, id: &str, category: &str, content: &str) -> Value {
        json!({
            "id": id,
            "projectId": project_id,
            "category": category,
            "content": content,
            "metadata": { "source": "test" },
            "createdBy": "agent:code-agent:session-under-test",
            "createdAt": "2026-11-23T12:00:00.000Z",
            "weight": 1.0,
        })
    }

    fn audit_event(project_id: &str, session_id: &str) -> Value {
        json!({
            "id": "evt-1",
            "timestamp": "2026-11-23T12:00:00.000Z",
            "projectId": project_id,
            "agentId": "agent:code-agent:session-under-test",
            "agentRole": "code-agent",
            "delegationChain": ["human:local", "agent:code-agent:session-under-test"],
            "eventType": "tool.invoked",
            "action": "Write",
            "details": { "tool": "Write", "toolUseId": "tu-1" },
            "sessionId": session_id,
            "result": "pending",
        })
    }

    #[test]
    fn test_memory_write_then_search_round_trips_through_the_real_store() {
        let fx = fixture();
        let written = call(
            &fx.host,
            1,
            METHOD_MEMORY_WRITE,
            json!({ "entry": entry(&fx.project_id, "e1", "learning", "stdio bridges need framing") }),
        );
        assert_eq!(written["ok"], true, "{written}");
        assert_eq!(written["id"], 1);

        let found = call(
            &fx.host,
            2,
            METHOD_MEMORY_SEARCH,
            json!({ "query": "framing", "limit": 5 }),
        );
        assert_eq!(found["ok"], true, "{found}");
        let results = found["result"].as_array().unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0]["id"], "e1");
        assert_eq!(
            results[0]["createdBy"],
            "agent:code-agent:session-under-test"
        );
        assert_eq!(results[0]["metadata"]["source"], "test");

        // Side effect read back independently of the bridge.
        let store =
            SqliteMemoryStore::new(&fx.project_path.join(".sdlc").join("memory.db")).unwrap();
        assert_eq!(
            store.read_entry("e1").unwrap().content,
            "stdio bridges need framing"
        );

        // Negative control: a query that matches nothing returns nothing.
        let missing = call(
            &fx.host,
            3,
            METHOD_MEMORY_SEARCH,
            json!({ "query": "nonexistentterm" }),
        );
        assert_eq!(missing["result"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn test_memory_search_honours_the_category_filter() {
        let fx = fixture();
        for (id, category) in [("l1", "learning"), ("c1", "convention")] {
            call(
                &fx.host,
                1,
                METHOD_MEMORY_WRITE,
                json!({ "entry": entry(&fx.project_id, id, category, "shared keyword") }),
            );
        }
        let conventions = call(
            &fx.host,
            2,
            METHOD_MEMORY_SEARCH,
            json!({ "query": "keyword", "category": "convention" }),
        );
        let results = conventions["result"].as_array().unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0]["id"], "c1");
    }

    #[test]
    fn test_memory_recent_lists_a_category_newest_first() {
        let fx = fixture();
        let mut older = entry(&fx.project_id, "older", "learning", "first");
        older["createdAt"] = json!("2026-11-22T12:00:00.000Z");
        let newer = entry(&fx.project_id, "newer", "learning", "second");
        let other = entry(&fx.project_id, "conv", "convention", "third");
        for e in [older, newer, other] {
            call(&fx.host, 1, METHOD_MEMORY_WRITE, json!({ "entry": e }));
        }

        let recent = call(
            &fx.host,
            2,
            METHOD_MEMORY_RECENT,
            json!({ "category": "learning" }),
        );
        let ids: Vec<&str> = recent["result"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, vec!["newer", "older"]);
    }

    #[test]
    fn test_memory_write_for_another_project_is_refused_and_writes_nothing() {
        let fx = fixture();
        let refused = call(
            &fx.host,
            1,
            METHOD_MEMORY_WRITE,
            json!({ "entry": entry("some-other-project", "e1", "learning", "smuggled") }),
        );
        assert_eq!(refused["ok"], false);
        assert_eq!(refused["error"]["code"], "scope_mismatch");

        let store =
            SqliteMemoryStore::new(&fx.project_path.join(".sdlc").join("memory.db")).unwrap();
        assert!(store.read_entry("e1").is_err(), "nothing was written");
    }

    #[test]
    fn test_audit_log_appends_to_the_project_audit_store() {
        let fx = fixture();
        let logged = call(
            &fx.host,
            1,
            METHOD_AUDIT_LOG,
            json!({ "event": audit_event(&fx.project_id, SESSION) }),
        );
        assert_eq!(logged["ok"], true, "{logged}");

        let events = FileSystemAuditStore::new(&fx.project_path)
            .unwrap()
            .get_by_session(SESSION)
            .unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].id, "evt-1");
        assert_eq!(events[0].agent_role, "code-agent");
    }

    #[test]
    fn test_audit_log_for_another_session_or_project_is_refused() {
        let fx = fixture();
        let wrong_session = call(
            &fx.host,
            1,
            METHOD_AUDIT_LOG,
            json!({ "event": audit_event(&fx.project_id, "session-someone-else") }),
        );
        assert_eq!(wrong_session["error"]["code"], "scope_mismatch");

        let wrong_project = call(
            &fx.host,
            2,
            METHOD_AUDIT_LOG,
            json!({ "event": audit_event("some-other-project", SESSION) }),
        );
        assert_eq!(wrong_project["error"]["code"], "scope_mismatch");

        let store = FileSystemAuditStore::new(&fx.project_path).unwrap();
        assert!(store.get_recent(10).unwrap().is_empty(), "nothing logged");
    }

    #[test]
    fn test_transcript_append_files_entries_under_the_bound_session() {
        let fx = fixture();

        let first = call(
            &fx.host,
            1,
            "transcript.append",
            json!({ "entry": {
                "timestamp": "2026-11-24T02:39:40.000Z",
                "kind": "message",
                "text": "Looking at the project.",
                "details": { "toolUseIds": ["tu-1"] },
            } }),
        );
        assert_eq!(first["ok"], true, "{first}");
        // An entry that tries to name another session, and omits details.
        let second = call(
            &fx.host,
            2,
            "transcript.append",
            json!({ "entry": {
                "sessionId": "some-other-session",
                "timestamp": "2026-11-24T02:39:58.000Z",
                "kind": "result",
                "text": "Done.",
            } }),
        );
        assert_eq!(second["ok"], true, "{second}");

        let store = FileSystemTranscriptStore::new(&fx.project_path).unwrap();
        let transcript = store.read(SESSION).unwrap();
        assert_eq!(transcript.len(), 2);
        assert_eq!(transcript[0].session_id, SESSION);
        assert_eq!(transcript[0].kind, TranscriptEntryKind::Message);
        assert_eq!(transcript[0].details["toolUseIds"][0], "tu-1");
        assert_eq!(transcript[1].session_id, SESSION);
        assert_eq!(transcript[1].text, "Done.");
        assert_eq!(transcript[1].details, json!({}));
        // Negative control: nothing was filed under the session it named.
        assert!(store.read("some-other-session").unwrap().is_empty());
    }

    #[test]
    fn test_transcript_append_with_an_unknown_kind_is_refused_and_writes_nothing() {
        let fx = fixture();

        let response = call(
            &fx.host,
            1,
            "transcript.append",
            json!({ "entry": {
                "timestamp": "2026-11-24T02:39:40.000Z",
                "kind": "thought",
                "text": "x",
            } }),
        );

        assert_eq!(response["ok"], false);
        assert_eq!(response["error"]["code"], "invalid_params");
        let store = FileSystemTranscriptStore::new(&fx.project_path).unwrap();
        assert!(store.read(SESSION).unwrap().is_empty());
    }

    #[test]
    fn test_reference_resolve_reads_files_standards_and_memory() {
        let fx = fixture();
        std::fs::create_dir_all(fx.project_path.join("docs")).unwrap();
        std::fs::write(fx.project_path.join("docs").join("note.md"), "hello ref").unwrap();
        call(
            &fx.host,
            1,
            METHOD_MEMORY_WRITE,
            json!({ "entry": entry(&fx.project_id, "m1", "learning", "resolver memory") }),
        );

        let file = call(
            &fx.host,
            2,
            METHOD_REFERENCE_RESOLVE,
            json!({ "uri": "file://docs/note.md" }),
        );
        assert_eq!(file["result"]["kind"], "content");
        assert_eq!(file["result"]["uri"], "file://docs/note.md");
        assert_eq!(file["result"]["content"], "hello ref");

        let standard = call(
            &fx.host,
            3,
            METHOD_REFERENCE_RESOLVE,
            json!({ "uri": "standards://coding-standards/rust" }),
        );
        assert_eq!(standard["result"]["content"], "# Rust standard");

        let memory = call(
            &fx.host,
            4,
            METHOD_REFERENCE_RESOLVE,
            json!({ "uri": "memory://query/resolver" }),
        );
        assert_eq!(memory["result"]["kind"], "memory");
        assert_eq!(memory["result"]["entries"][0]["id"], "m1");
        assert_eq!(memory["result"]["entries"][0]["projectId"], fx.project_id);
    }

    #[test]
    fn test_reference_resolve_refuses_traversal_and_unknown_schemes() {
        let fx = fixture();
        let traversal = call(
            &fx.host,
            1,
            METHOD_REFERENCE_RESOLVE,
            json!({ "uri": "file://../../etc/passwd" }),
        );
        assert_eq!(traversal["ok"], false);
        assert_eq!(traversal["error"]["code"], "resolve_error");

        let unknown = call(
            &fx.host,
            2,
            METHOD_REFERENCE_RESOLVE,
            json!({ "uri": "ftp://example/file" }),
        );
        assert_eq!(unknown["error"]["code"], "resolve_error");
    }

    #[test]
    fn test_bad_requests_get_error_responses_not_panics() {
        let fx = fixture();

        let unknown = call(&fx.host, 1, "memory.drop_everything", json!({}));
        assert_eq!(unknown["error"]["code"], "unknown_method");
        assert_eq!(unknown["id"], 1);

        let bad_params = call(&fx.host, 2, METHOD_MEMORY_SEARCH, json!({ "limit": 5 }));
        assert_eq!(bad_params["error"]["code"], "invalid_params");

        // A request with no method still gets a response correlated by id.
        let LineOutcome::Response(line) = fx.host.handle_line(r#"{"kind":"request","id":9}"#)
        else {
            panic!("expected a response");
        };
        let malformed: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(malformed["id"], 9);
        assert_eq!(malformed["error"]["code"], "invalid_request");
    }

    #[test]
    fn test_status_lines_are_parsed_and_noise_is_ignored() {
        let fx = fixture();

        assert_eq!(
            fx.host
                .handle_line(r#"{"kind":"status","status":"failed","error":"boom","session":"s"}"#),
            LineOutcome::Status(SidecarStatus {
                status: "failed".to_string(),
                error: Some("boom".to_string()),
            })
        );

        // Stray output on the shared stdout is dropped, never an error.
        for noise in [
            "",
            "plain text from a dependency",
            "[1,2,3]",
            r#"{"some":"other json"}"#,
            r#"{"kind":"response","id":1,"ok":true}"#,
            r#"{"kind":"status"}"#,
        ] {
            assert_eq!(fx.host.handle_line(noise), LineOutcome::Ignored, "{noise}");
        }
    }
}
