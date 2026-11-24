// src-tauri/tests/acceptance/issue_078_session_transcript.rs
//
// Acceptance: issue #78 — a record of what an agent said, per session.
//
// Definition of done (the Rust-owned half): what a running agent reports
// through the storage bridge — the task it was given, each thing it says, and
// how the run ended — is kept per session under the project's `.sdlc/`, in the
// order it happened, and can be read back after the agent process is gone. A
// run can only ever add to its own session's record, and a caller can only
// read a session's record, never an arbitrary file.
//
// Real stores: a registered project in a temp directory. Entries go in the way
// a sidecar sends them (request lines to a `BridgeHost`) and come back the way
// the UI asks for them (the `agent_transcript` command's logic, which opens
// the store afresh), and the raw file is read too.
//
// Not covered here: that the sidecar turns SDK messages into these requests
// (agents/tests/sidecar-runner.test.ts, and the real Node client in
// tests/storage_bridge.rs), and the session view that renders the record —
// the frontend has no test tier in Phase 1.

use std::fs;
use std::path::PathBuf;

use serde_json::{json, Value};

use saor_lib::bridge::{BridgeHost, LineOutcome};
use saor_lib::commands::transcript;
use saor_lib::project::{ProjectRecord, ProjectRegistry};
use saor_lib::transcript::TranscriptEntryKind;

struct Project {
    registry: ProjectRegistry,
    record: ProjectRecord,
    standards_root: PathBuf,
    _tmp: tempfile::TempDir,
}

fn project() -> Project {
    let tmp = tempfile::tempdir().unwrap();
    let registry = ProjectRegistry::open_in_memory().unwrap();
    let record = registry
        .create("Transcripts", &tmp.path().join("proj"), "")
        .unwrap();
    let standards_root = tmp.path().join("standards");
    fs::create_dir_all(&standards_root).unwrap();
    Project {
        registry,
        record,
        standards_root,
        _tmp: tmp,
    }
}

impl Project {
    /// The bridge host a spawned agent for `session` would be attached to.
    fn host_for(&self, session: &str) -> BridgeHost {
        BridgeHost::new(
            session,
            &self.record.id,
            &PathBuf::from(&self.record.path),
            &self.standards_root,
        )
    }

    fn transcript_file(&self, session: &str) -> PathBuf {
        PathBuf::from(&self.record.path)
            .join(".sdlc")
            .join("sessions")
            .join(format!("{session}.jsonl"))
    }
}

/// Sends one `transcript.append` request line, as a sidecar would, and returns
/// the parsed response.
fn append(host: &BridgeHost, id: u64, entry: Value) -> Value {
    let line = json!({
        "kind": "request",
        "id": id,
        "method": "transcript.append",
        "params": { "entry": entry },
    })
    .to_string();
    match host.handle_line(&line) {
        LineOutcome::Response(response) => serde_json::from_str(&response).unwrap(),
        other => panic!("expected a response, got {other:?}"),
    }
}

fn entry(kind: &str, text: &str, details: Value) -> Value {
    json!({
        "timestamp": "2026-11-24T02:39:40.000Z",
        "kind": kind,
        "text": text,
        "details": details,
    })
}

#[test]
fn what_an_agent_reports_is_kept_in_order_and_outlives_the_run() {
    let project = project();

    // Negative control: before the run there is no record and no file.
    assert!(
        transcript::for_session(&project.registry, &project.record.id, "session-a")
            .unwrap()
            .is_empty()
    );
    assert!(!project.transcript_file("session-a").exists());

    {
        // The run: its host lives only as long as the agent process does.
        let host = project.host_for("session-a");
        let sent = [
            entry("task", "Create a hello world web page", json!({})),
            entry(
                "message",
                "I'll look at the project first.",
                json!({ "toolUseIds": ["tu-1"] }),
            ),
            entry("message", "", json!({ "toolUseIds": ["tu-2", "tu-3"] })),
            entry(
                "result",
                "Created src/index.html.",
                json!({ "isError": false, "numTurns": 4, "durationMs": 24000 }),
            ),
        ];
        for (index, entry) in sent.into_iter().enumerate() {
            let response = append(&host, index as u64 + 1, entry);
            assert_eq!(response["ok"], true, "{response}");
        }
    }

    // Read back the way the UI does, through a freshly opened store.
    let record =
        transcript::for_session(&project.registry, &project.record.id, "session-a").unwrap();
    assert_eq!(
        record.iter().map(|e| e.kind).collect::<Vec<_>>(),
        [
            TranscriptEntryKind::Task,
            TranscriptEntryKind::Message,
            TranscriptEntryKind::Message,
            TranscriptEntryKind::Result,
        ]
    );
    assert_eq!(record[0].text, "Create a hello world web page");
    assert_eq!(record[1].text, "I'll look at the project first.");
    assert_eq!(record[2].text, "");
    assert_eq!(record[2].details["toolUseIds"], json!(["tu-2", "tu-3"]));
    assert_eq!(record[3].text, "Created src/index.html.");
    assert_eq!(record[3].details["numTurns"], 4);
    assert!(record.iter().all(|e| e.session_id == "session-a"));

    // Read the raw file: one JSON object per line, camelCase, under .sdlc/.
    let raw = fs::read_to_string(project.transcript_file("session-a")).unwrap();
    let lines: Vec<Value> = raw
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(lines.len(), 4);
    assert_eq!(lines[1]["sessionId"], "session-a");
    assert_eq!(lines[1]["kind"], "message");
}

#[test]
fn a_run_can_only_add_to_its_own_sessions_record() {
    let project = project();
    let host_a = project.host_for("session-a");
    let host_b = project.host_for("session-b");

    append(&host_a, 1, entry("message", "from a", json!({})));
    append(&host_b, 1, entry("message", "from b", json!({})));
    // Session a's sidecar claims its entry belongs to session b.
    let mut smuggled = entry("message", "a pretending to be b", json!({}));
    smuggled["sessionId"] = json!("session-b");
    let response = append(&host_a, 2, smuggled);
    assert_eq!(response["ok"], true, "{response}");

    let read = |session: &str| -> Vec<String> {
        transcript::for_session(&project.registry, &project.record.id, session)
            .unwrap()
            .into_iter()
            .map(|e| e.text)
            .collect()
    };
    // The claim was ignored: the entry is in a's record, and b's holds only
    // what b's own run reported.
    assert_eq!(read("session-a"), ["from a", "a pretending to be b"]);
    assert_eq!(read("session-b"), ["from b"]);

    // Negative control: a session that reported nothing has an empty record.
    assert!(read("session-c").is_empty());
}

#[test]
fn a_record_is_read_by_session_and_never_by_path() {
    let project = project();
    let host = project.host_for("session-a");
    append(&host, 1, entry("message", "kept", json!({})));

    // A JSONL file that is not a transcript, where a traversing id would land.
    let audit_dir = PathBuf::from(&project.record.path)
        .join(".sdlc")
        .join("audit");
    fs::create_dir_all(&audit_dir).unwrap();
    let line = json!({
        "sessionId": "session-a",
        "timestamp": "2026-11-24T02:39:40.000Z",
        "kind": "message",
        "text": "not a transcript",
    });
    fs::write(audit_dir.join("leak.jsonl"), format!("{line}\n")).unwrap();

    for bad in [
        "../audit/leak",
        "session-a/../../audit/leak",
        "",
        "session.a",
    ] {
        let result = transcript::for_session(&project.registry, &project.record.id, bad);
        assert!(result.is_err(), "{bad:?} was read: {result:?}");
    }
    assert!(
        transcript::for_session(&project.registry, "no-such-project", "session-a").is_err(),
        "an unknown project has no transcripts to read"
    );

    // Negative control: the real session still reads.
    let record =
        transcript::for_session(&project.registry, &project.record.id, "session-a").unwrap();
    assert_eq!(record.len(), 1);
    assert_eq!(record[0].text, "kept");
}
