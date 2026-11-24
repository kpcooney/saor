// Acceptance: issue #6 — reference resolver.
//
// Definition of done: a reference URI from a manifest resolves to the living
// document it names — a project file, a standard (project override before
// system default), or a memory query — and a URI that names anything outside
// those roots, or uses a scheme the resolver does not serve, is refused.
//
// Real stores: a project directory, a standards directory and a SQLite memory
// file, all in a temp directory. Every refusal is paired with a file that
// really exists at the place the URI was trying to reach, so the refusal is
// the resolver's doing and not a missing file.

use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::Connection;

use saor_lib::memory::{MemoryCategory, MemoryEntry, SqliteMemoryStore};
use saor_lib::references::{resolve_ref, ResolvedReference, ResolverError};

/// A workspace laid out as on a developer's machine: a project, the system
/// standards beside it, and a file that belongs to neither.
struct Workspace {
    _tmp: tempfile::TempDir,
    project_root: PathBuf,
    standards_root: PathBuf,
    memory: Connection,
}

fn write(path: &Path, content: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, content).unwrap();
}

fn workspace() -> Workspace {
    let tmp = tempfile::tempdir().unwrap();
    let project_root = tmp.path().join("project");
    let standards_root = tmp.path().join("standards");

    write(&project_root.join("docs/adr/001-foo.md"), "# ADR 001");
    write(&tmp.path().join("secret.txt"), "outside the project");
    write(
        &standards_root.join("coding-standards/typescript.md"),
        "system typescript standard",
    );
    write(
        &standards_root.join("coding-standards/rust.md"),
        "system rust standard",
    );
    write(
        &project_root.join(".sdlc/standards/coding-standards/rust.md"),
        "project rust override",
    );

    // The project's real memory database, written through the store and then
    // opened by path — the resolver reads what is on disk.
    let memory_db = project_root.join(".sdlc").join("memory.db");
    {
        let store = SqliteMemoryStore::new(&memory_db).unwrap();
        store
            .register_project("proj-acceptance", "Acceptance", "", "2026-06-01T00:00:00Z")
            .unwrap();
        for (id, content) in [
            ("auth-jwt", "auth tokens are JWT signed with RS256"),
            ("audit-jsonl", "audit events are JSON lines"),
        ] {
            store
                .write_entry(&MemoryEntry {
                    id: id.to_string(),
                    project_id: "proj-acceptance".to_string(),
                    category: MemoryCategory::Context,
                    content: content.to_string(),
                    metadata: serde_json::Value::Null,
                    created_by: "agent:code-agent:acceptance-6".to_string(),
                    created_at: "2026-06-01T12:00:00Z".to_string(),
                    weight: 1.0,
                })
                .unwrap();
        }
    }

    Workspace {
        memory: Connection::open(&memory_db).unwrap(),
        _tmp: tmp,
        project_root,
        standards_root,
    }
}

impl Workspace {
    fn resolve(&self, uri: &str) -> Result<ResolvedReference, ResolverError> {
        resolve_ref(uri, &self.project_root, &self.standards_root, &self.memory)
    }

    /// Resolves a URI that must yield text content.
    fn content(&self, uri: &str) -> String {
        match self.resolve(uri) {
            Ok(ResolvedReference::Content(content)) => content,
            other => panic!("{uri} did not resolve to content: {other:?}"),
        }
    }
}

#[test]
fn a_file_uri_resolves_to_the_project_file_and_never_to_anything_outside_the_project() {
    let ws = workspace();

    assert_eq!(ws.content("file:///docs/adr/001-foo.md"), "# ADR 001");

    // The file the traversal aims at exists, so only the resolver stops it.
    assert!(ws.project_root.join("../secret.txt").is_file());
    assert!(matches!(
        ws.resolve("file:///../secret.txt"),
        Err(ResolverError::PathTraversal { .. })
    ));
    assert!(matches!(
        ws.resolve("file:///docs/../../secret.txt"),
        Err(ResolverError::PathTraversal { .. })
    ));

    // A missing file is reported as missing, not as empty content.
    assert!(matches!(
        ws.resolve("file:///docs/adr/999-missing.md"),
        Err(ResolverError::NotFound { .. })
    ));
}

#[test]
fn a_standards_uri_resolves_through_the_override_chain() {
    let ws = workspace();

    // No project override: the system default.
    assert_eq!(
        ws.content("standards://coding-standards/typescript"),
        "system typescript standard"
    );
    // Project override present: it wins over the system default.
    assert_eq!(
        ws.content("standards://coding-standards/rust"),
        "project rust override"
    );

    // Negative control: the override is what changed the answer — a project
    // without one gets the system default for the same URI.
    let other_project = tempfile::tempdir().unwrap();
    match resolve_ref(
        "standards://coding-standards/rust",
        other_project.path(),
        &ws.standards_root,
        &ws.memory,
    ) {
        Ok(ResolvedReference::Content(content)) => assert_eq!(content, "system rust standard"),
        other => panic!("expected the system default, got {other:?}"),
    }

    // In neither tier: not found. Outside both roots: refused.
    assert!(matches!(
        ws.resolve("standards://coding-standards/cobol"),
        Err(ResolverError::NotFound { .. })
    ));
    write(&ws.standards_root.join("../secret.md"), "outside standards");
    assert!(matches!(
        ws.resolve("standards://../secret"),
        Err(ResolverError::PathTraversal { .. })
    ));
}

#[test]
fn a_memory_uri_resolves_to_the_entries_matching_its_query() {
    let ws = workspace();

    match ws.resolve("memory://query/auth+jwt") {
        Ok(ResolvedReference::MemoryEntries(entries)) => {
            let ids: Vec<&str> = entries.iter().map(|e| e.id.as_str()).collect();
            assert_eq!(ids, ["auth-jwt"]);
            assert_eq!(entries[0].content, "auth tokens are JWT signed with RS256");
        }
        other => panic!("expected memory entries, got {other:?}"),
    }

    // Negative control: a query nothing matches yields no entries.
    match ws.resolve("memory://query/kubernetes") {
        Ok(ResolvedReference::MemoryEntries(entries)) => assert!(entries.is_empty()),
        other => panic!("expected an empty entry list, got {other:?}"),
    }

    assert!(matches!(
        ws.resolve("memory://auth"),
        Err(ResolverError::MalformedUri { .. })
    ));
}

#[test]
fn a_uri_with_an_unserved_scheme_is_refused_rather_than_guessed_at() {
    let ws = workspace();

    // The path is one that resolves fine under file://, so the scheme is the
    // only thing wrong with these.
    assert_eq!(ws.content("file:///docs/adr/001-foo.md"), "# ADR 001");
    assert!(matches!(
        ws.resolve("https:///docs/adr/001-foo.md"),
        Err(ResolverError::UnknownScheme { .. })
    ));
    assert!(matches!(
        ws.resolve("docs/adr/001-foo.md"),
        Err(ResolverError::UnknownScheme { .. })
    ));
    // tracker:// is reserved for Phase 3 and says so.
    assert!(matches!(
        ws.resolve("tracker://issue/167"),
        Err(ResolverError::TrackerNotImplemented { .. })
    ));
}
