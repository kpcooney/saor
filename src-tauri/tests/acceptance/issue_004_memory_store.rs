// src-tauri/tests/acceptance/issue_004_memory_store.rs
//
// Acceptance: issue #4 — SQLite memory store with FTS5 keyword search.
//
// Definition of done: knowledge an agent writes is durable in the project's
// single SQLite file, comes back intact by id, and is found by keyword search
// in relevance order — and nothing else comes back.
//
// Real store: a SQLite file in a temp directory, closed and reopened so that
// what is read is what reached the disk.

use std::path::{Path, PathBuf};

use saor_lib::memory::{MemoryCategory, MemoryEntry, MemoryError, SqliteMemoryStore};

const PROJECT: &str = "proj-acceptance";

fn memory_db(project_root: &Path) -> PathBuf {
    project_root.join(".sdlc").join("memory.db")
}

/// Opens the project's memory store, as the app does on every launch.
fn open_store(project_root: &Path) -> SqliteMemoryStore {
    let store = SqliteMemoryStore::new(&memory_db(project_root)).unwrap();
    store
        .register_project(PROJECT, "Acceptance", "", "2026-06-01T00:00:00Z")
        .unwrap();
    store
}

fn entry(id: &str, category: MemoryCategory, content: &str) -> MemoryEntry {
    MemoryEntry {
        id: id.to_string(),
        project_id: PROJECT.to_string(),
        category,
        content: content.to_string(),
        metadata: serde_json::json!({ "issue": "4", "files": ["src/memory/store.rs"] }),
        created_by: "agent:code-agent:acceptance-4".to_string(),
        created_at: "2026-06-01T12:00:00Z".to_string(),
        weight: 0.75,
    }
}

fn ids(entries: &[MemoryEntry]) -> Vec<&str> {
    entries.iter().map(|e| e.id.as_str()).collect()
}

#[test]
fn a_written_entry_survives_reopening_the_database_with_every_field_intact() {
    let project = tempfile::tempdir().unwrap();
    let written = entry(
        "entry-1",
        MemoryCategory::Convention,
        "Storage errors use thiserror enums",
    );

    {
        let store = open_store(project.path());
        store.write_entry(&written).unwrap();
    } // The store, and its connection, are closed here.

    assert!(memory_db(project.path()).is_file());
    let reopened = open_store(project.path());
    let read = reopened.read_entry("entry-1").unwrap();
    assert_eq!(read.id, written.id);
    assert_eq!(read.project_id, written.project_id);
    assert_eq!(read.category, written.category);
    assert_eq!(read.content, written.content);
    assert_eq!(read.metadata, written.metadata);
    assert_eq!(read.created_by, written.created_by);
    assert_eq!(read.created_at, written.created_at);
    assert_eq!(read.weight, written.weight);

    // Negative control: an id that was never written is not found.
    assert!(matches!(
        reopened.read_entry("entry-never-written"),
        Err(MemoryError::NotFound(id)) if id == "entry-never-written"
    ));
}

#[test]
fn opening_an_existing_database_again_changes_nothing_in_it() {
    let project = tempfile::tempdir().unwrap();
    open_store(project.path())
        .write_entry(&entry(
            "kept",
            MemoryCategory::Learning,
            "schema setup is idempotent",
        ))
        .unwrap();

    // Each open runs schema initialization and project registration again.
    for _ in 0..3 {
        let store = open_store(project.path());
        assert_eq!(ids(&store.search("idempotent", 10).unwrap()), ["kept"]);
        assert_eq!(
            ids(&store
                .recent_by_category(&MemoryCategory::Learning, 10)
                .unwrap()),
            ["kept"],
            "exactly one copy: reopening neither dropped nor duplicated the entry"
        );
    }

    // Negative control: a different project's database starts empty, so the
    // entry above came from this file and not from setup.
    let other = tempfile::tempdir().unwrap();
    assert!(open_store(other.path())
        .search("idempotent", 10)
        .unwrap()
        .is_empty());
}

#[test]
fn keyword_search_returns_only_matching_entries_most_relevant_first() {
    let project = tempfile::tempdir().unwrap();
    {
        let store = open_store(project.path());
        store
            .write_entry(&entry(
                "passing-mention",
                MemoryCategory::Learning,
                "Run the migration before deploying the new build of the service to staging",
            ))
            .unwrap();
        store
            .write_entry(&entry(
                "about-migrations",
                MemoryCategory::Learning,
                "migration migration migration checklist",
            ))
            .unwrap();
        store
            .write_entry(&entry(
                "unrelated",
                MemoryCategory::Learning,
                "Audit events are appended as JSON lines",
            ))
            .unwrap();
    }

    // Search through a reopened store: the index is on disk, not in memory.
    let store = open_store(project.path());
    let hits = store.search("migration", 10).unwrap();
    assert_eq!(ids(&hits), ["about-migrations", "passing-mention"]);

    // The limit truncates from the low-relevance end.
    assert_eq!(
        ids(&store.search("migration", 1).unwrap()),
        ["about-migrations"]
    );

    // Negative control: a term no entry contains matches nothing.
    assert!(store.search("kubernetes", 10).unwrap().is_empty());
}

#[test]
fn category_search_and_recent_listing_never_cross_categories() {
    let project = tempfile::tempdir().unwrap();
    let store = open_store(project.path());
    store
        .write_entry(&entry(
            "learning-1",
            MemoryCategory::Learning,
            "FTS5 triggers keep the index in sync",
        ))
        .unwrap();
    store
        .write_entry(&entry(
            "convention-1",
            MemoryCategory::Convention,
            "FTS5 queries go through the store",
        ))
        .unwrap();

    let conventions = store
        .search_in_category("fts5", Some(&MemoryCategory::Convention), 10)
        .unwrap();
    assert_eq!(ids(&conventions), ["convention-1"]);
    assert_eq!(
        ids(&store
            .recent_by_category(&MemoryCategory::Learning, 10)
            .unwrap()),
        ["learning-1"]
    );

    // Negative control: with no category the same query sees both entries, so
    // the filter above is what excluded the other one.
    assert_eq!(store.search_in_category("fts5", None, 10).unwrap().len(), 2);
    assert!(store
        .recent_by_category(&MemoryCategory::Context, 10)
        .unwrap()
        .is_empty());
}

#[test]
fn an_entry_for_an_unregistered_project_is_refused_and_leaves_nothing_behind() {
    let project = tempfile::tempdir().unwrap();
    let store = open_store(project.path());

    let mut orphan = entry("orphan", MemoryCategory::Learning, "orphaned knowledge");
    orphan.project_id = "proj-never-registered".to_string();
    // The refusal is the database's foreign key, not some unrelated failure.
    match store.write_entry(&orphan) {
        Err(MemoryError::Database(error)) => assert!(
            error.to_string().contains("FOREIGN KEY"),
            "expected a foreign-key refusal, got: {error}"
        ),
        other => panic!("expected a database refusal, got {other:?}"),
    }

    assert!(matches!(
        store.read_entry("orphan"),
        Err(MemoryError::NotFound(_))
    ));
    assert!(store.search("orphaned", 10).unwrap().is_empty());

    // Negative control: the same entry under the registered project is stored
    // and searchable.
    orphan.project_id = PROJECT.to_string();
    store.write_entry(&orphan).unwrap();
    assert_eq!(ids(&store.search("orphaned", 10).unwrap()), ["orphan"]);
}
