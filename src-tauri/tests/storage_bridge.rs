// src-tauri/tests/storage_bridge.rs
//
// Cross-process acceptance test for the Node↔Rust storage bridge (issue #59,
// ADR-009). It runs the two real halves against each other with no Tauri
// runtime and no LLM:
//
//   - Node side: agents/tests/support/bridge-probe.mjs, which drives the
//     compiled bridge client and the memory / audit / reference adapters
//     (agents/dist/bridge/) through every bridge method, the session
//     transcript's included.
//   - Rust side: this test, which plays the spawner — it reads the child's
//     stdout line by line, hands each line to a real `BridgeHost` bound to a
//     temp-dir project with REAL stores, and writes each response to the
//     child's stdin.
//
// It then checks both directions: what the TypeScript adapters got back (the
// probe's report), and what actually landed in the stores (read back here,
// independently of the bridge). Refusals are the negative controls — a
// cross-project write, a path traversal, and an unknown scheme must all be
// rejected and leave nothing behind.
//
// Prerequisites: `node` on PATH (already required to run agents, ADR-002) and a
// current build of the agents package. The test fails with instructions, rather
// than skipping, if the build is missing or older than its sources.

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde_json::Value;

use saor_lib::audit::{AuditEventType, FileSystemAuditStore};
use saor_lib::bridge::{BridgeHost, LineOutcome};
use saor_lib::memory::SqliteMemoryStore;
use saor_lib::project::ProjectRegistry;
use saor_lib::transcript::{FileSystemTranscriptStore, TranscriptEntryKind};

const SESSION: &str = "session-bridge-probe";

/// Memory content the probe writes and reads back: it contains U+2028 (LINE
/// SEPARATOR) and U+2029 (PARAGRAPH SEPARATOR), which JSON does not escape.
const SEPARATOR_MEMORY: &str = "separated\u{2028}by\u{2029}unicode";

/// A project file with the same two characters, resolved through the bridge.
const SEPARATOR_FILE: &str = "a note\u{2028}with\u{2029}separators";

fn agents_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri has a parent directory")
        .join("agents")
}

/// Fails with build instructions unless every bridge source has a compiled
/// counterpart at least as new as itself. Without this a stale `dist/` could
/// make the test pass or fail for reasons unrelated to the code under review.
fn require_current_agents_build() {
    let agents = agents_dir();
    for module in ["protocol", "client", "line-reader", "adapters"] {
        let source = agents
            .join("src")
            .join("bridge")
            .join(format!("{module}.ts"));
        let built = agents
            .join("dist")
            .join("bridge")
            .join(format!("{module}.js"));
        let modified = |path: &Path| std::fs::metadata(path).and_then(|m| m.modified()).ok();
        let is_current = match (modified(&source), modified(&built)) {
            (Some(source_time), Some(built_time)) => built_time >= source_time,
            _ => false,
        };
        assert!(
            is_current,
            "{} is missing or older than {}.\nBuild the agent layer first: (cd agents && npm run build)",
            built.display(),
            source.display(),
        );
    }
}

/// Runs the probe to completion against `host`, servicing its requests, and
/// returns the report from its final `completed` status line.
fn run_probe(host: &BridgeHost, project_id: &str) -> Value {
    let probe = agents_dir()
        .join("tests")
        .join("support")
        .join("bridge-probe.mjs");
    let mut child = Command::new("node")
        .arg(&probe)
        .arg(project_id)
        .arg(SESSION)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .expect("failed to spawn `node` — is Node.js on PATH?");

    let mut stdin = child.stdin.take().expect("child stdin is piped");
    let stdout = BufReader::new(child.stdout.take().expect("child stdout is piped"));

    let mut report = None;
    let mut ignored_lines = 0;
    for line in stdout.lines() {
        let line = line.expect("probe stdout is valid UTF-8");
        match host.handle_line(&line) {
            LineOutcome::Response(response) => {
                // The probe may already have exited after a failure; a write
                // error then is expected and the exit status reports it.
                let _ = writeln!(stdin, "{response}");
            }
            LineOutcome::Status(status) => {
                assert_eq!(
                    status.status,
                    "completed",
                    "the probe failed: {}",
                    status.error.unwrap_or_default()
                );
                let raw: Value = serde_json::from_str(&line).unwrap();
                report = Some(raw["report"].clone());
            }
            LineOutcome::Ignored => ignored_lines += 1,
        }
    }
    drop(stdin);

    let status = child.wait().expect("failed to wait for the probe");
    assert!(status.success(), "the probe exited with {status}");
    assert_eq!(
        ignored_lines, 1,
        "exactly the probe's one stray stdout line is dropped"
    );
    report.expect("the probe reported a result")
}

#[test]
fn node_adapters_round_trip_through_the_real_rust_stores() {
    require_current_agents_build();

    // A registered project with real on-disk stores, a file to reference, and
    // a system-default standards tree.
    let tmp = tempfile::tempdir().unwrap();
    let project_path = tmp.path().join("proj");
    let registry = ProjectRegistry::open_in_memory().unwrap();
    let project = registry.create("Bridge probe", &project_path, "").unwrap();
    std::fs::create_dir_all(project_path.join("docs")).unwrap();
    std::fs::write(project_path.join("docs").join("note.md"), "a project note").unwrap();
    std::fs::write(
        project_path.join("docs").join("separators.md"),
        SEPARATOR_FILE,
    )
    .unwrap();
    std::fs::write(tmp.path().join("outside.txt"), "outside the project").unwrap();
    let standards_root = tmp.path().join("standards");
    std::fs::create_dir_all(standards_root.join("coding-standards")).unwrap();
    std::fs::write(
        standards_root.join("coding-standards").join("rust.md"),
        "# Rust standard",
    )
    .unwrap();

    let host = BridgeHost::new(SESSION, &project.id, &project_path, &standards_root);
    let report = run_probe(&host, &project.id);
    let agent_id = format!("agent:code-agent:{SESSION}");

    // --- What the TypeScript adapters got back ------------------------------

    // memory.search: the entry round-tripped with camelCase fields intact, and
    // the category filter excluded it when asked for a different category.
    let search = report["search"].as_array().unwrap();
    assert_eq!(search.len(), 1, "{report}");
    assert_eq!(search[0]["id"], "probe-learning");
    assert_eq!(search[0]["projectId"], project.id);
    assert_eq!(search[0]["createdBy"], agent_id);
    assert_eq!(search[0]["metadata"]["source"], "bridge-probe");
    assert_eq!(report["filteredOutCount"], 0);

    // memory.recent ×2, composed into the project context on the Node side.
    assert_eq!(report["context"]["projectId"], project.id);
    assert_eq!(
        report["context"]["recentLearnings"][0]["id"],
        "probe-learning"
    );
    assert_eq!(
        report["context"]["conventions"][0]["id"],
        "probe-convention"
    );

    // reference.resolve for each supported scheme.
    assert_eq!(report["file"]["kind"], "content");
    assert_eq!(report["file"]["content"], "a project note");
    assert_eq!(report["standard"]["content"], "# Rust standard");
    assert_eq!(report["memoryRef"]["kind"], "memory");
    assert_eq!(report["memoryRef"]["entries"][0]["id"], "probe-convention");

    // Concurrent requests were each answered with their own result.
    assert_eq!(
        report["concurrentIds"],
        serde_json::json!(["probe-learning", "probe-convention", "content"])
    );

    // U+2028 and U+2029 are unescaped in JSON, so they cross the bridge raw.
    // Each response carrying them reached the adapter whole (issue #68): a
    // client that ended a line at either one would have hung instead.
    assert_eq!(report["separators"]["searchContent"], SEPARATOR_MEMORY);
    assert_eq!(report["separators"]["contextContent"], SEPARATOR_MEMORY);
    assert_eq!(report["separators"]["fileContent"], SEPARATOR_FILE);

    // Negative controls: each refusal reached the adapter with Rust's code.
    assert_eq!(report["refusals"]["otherProjectWrite"], "scope_mismatch");
    assert_eq!(report["refusals"]["traversal"], "resolve_error");
    assert_eq!(report["refusals"]["unknownScheme"], "resolve_error");

    // --- What actually landed in the stores ---------------------------------

    let memory = SqliteMemoryStore::new(&project_path.join(".sdlc").join("memory.db")).unwrap();
    let learning = memory.read_entry("probe-learning").unwrap();
    assert_eq!(learning.content, "stdio bridges need line framing");
    assert_eq!(learning.created_by, agent_id);
    assert_eq!(
        memory.read_entry("probe-separators").unwrap().content,
        SEPARATOR_MEMORY,
        "the separators were stored as sent"
    );
    assert!(
        memory.read_entry("probe-smuggled").is_err(),
        "the refused cross-project write left nothing behind"
    );

    let events = FileSystemAuditStore::new(&project_path)
        .unwrap()
        .get_by_session(SESSION)
        .unwrap();
    assert_eq!(events.len(), 1, "one event, filed under the Saor session");
    let event = &events[0];
    assert_eq!(event.id, "probe-event");
    assert_eq!(event.event_type, AuditEventType::ToolInvoked);
    assert_eq!(event.agent_id, agent_id);
    assert_eq!(event.issue_ref.as_deref(), Some("59"));
    // The adapter restamped the session and kept the SDK's id in details.
    assert_eq!(event.details["sdkSessionId"], "sdk-session-from-probe");
    assert_eq!(event.details["toolUseId"], "tu-probe");

    // The session transcript: three entries in the order recorded, filed
    // under the session the host is bound to. The entry of an unknown kind
    // was refused, reported to the recorder, and left nothing behind.
    let transcript = FileSystemTranscriptStore::new(&project_path)
        .unwrap()
        .read(SESSION)
        .unwrap();
    assert_eq!(
        transcript.iter().map(|e| e.kind).collect::<Vec<_>>(),
        [
            TranscriptEntryKind::Task,
            TranscriptEntryKind::Message,
            TranscriptEntryKind::Result,
        ]
    );
    assert_eq!(transcript[1].text, "said with a\u{2028}separator");
    assert_eq!(transcript[1].details["toolUseIds"][0], "tu-probe");
    assert_eq!(transcript[2].details["numTurns"], 1);
    assert!(transcript.iter().all(|e| e.session_id == SESSION));
    let failures = report["transcriptFailures"].as_array().unwrap();
    assert_eq!(failures.len(), 1, "{report}");
    assert!(
        failures[0].as_str().unwrap().contains("thought"),
        "{report}"
    );
}
