// memory/fts.rs
//
// FTS5 keyword search implementation for the memory store. Wraps SQLite's
// FTS5 full-text search extension to provide fast, ranked search over
// memory_entries. Search results are returned ordered by relevance using
// BM25 ranking, which FTS5 provides natively via the rank column.
//
// The FTS index is kept in sync with memory_entries via SQLite triggers
// defined in schema.rs. This module only reads from the index — writes
// flow through SqliteMemoryStore::write_entry(), which inserts into
// memory_entries, and the trigger automatically updates memory_fts.
//
// Semantic/vector search is explicitly deferred to Phase 4. When added,
// it will be a separate search path (sqlite-vec virtual table), combined
// with FTS5 via reciprocal rank fusion (RRF) in a future hybridSearch.
//
// See docs/architecture/sdlc-agent-architecture-research-v4.md Section 6.6
// for the semantic search deferral rationale and the planned upgrade path.

use rusqlite::{params, Connection};

use super::schema::{MemoryEntry, MemoryError};
use super::store::row_to_entry;

/// Searches memory entries using FTS5 keyword matching, returning results
/// ranked by BM25 relevance.
///
/// The query string supports FTS5 query syntax (AND, OR, NOT, phrase
/// matching with quotes, prefix matching with *). For simple keyword
/// searches, just pass the search terms.
///
/// Results are ordered by relevance (most relevant first) and limited
/// to at most `limit` entries.
pub fn keyword_search(
    conn: &Connection,
    query: &str,
    limit: i64,
) -> Result<Vec<MemoryEntry>, MemoryError> {
    // Join memory_fts with memory_entries to get the full row data.
    // bm25(memory_fts) returns a negative relevance score (more negative = more relevant),
    // so we ORDER BY rank ASC (or equivalently, by bm25 ascending).
    let mut stmt = conn.prepare(
        "SELECT me.id, me.project_id, me.category, me.content, me.metadata,
                me.created_by, me.created_at, me.weight
         FROM memory_fts fts
         JOIN memory_entries me ON me.rowid = fts.rowid
         WHERE memory_fts MATCH ?1
         ORDER BY fts.rank
         LIMIT ?2",
    )?;

    let entries = stmt
        .query_map(params![query, limit], row_to_entry)?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::super::schema::MemoryCategory;
    use super::super::store::SqliteMemoryStore;
    use super::*;

    /// Sets up a test project row so foreign key constraints pass.
    fn insert_test_project(store: &SqliteMemoryStore) {
        store
            .connection()
            .execute(
                "INSERT OR IGNORE INTO projects (id, name, description, created_at, config)
                 VALUES ('test-project', 'Test Project', 'Unit test project', '2026-02-25T12:00:00Z', '{}')",
                [],
            )
            .unwrap();
    }

    /// Helper to create a test entry with given ID, content, and category.
    fn make_entry(id: &str, content: &str, category: MemoryCategory) -> MemoryEntry {
        MemoryEntry {
            id: id.to_string(),
            project_id: "test-project".to_string(),
            category,
            content: content.to_string(),
            metadata: serde_json::json!(null),
            created_by: "agent:test:fts".to_string(),
            created_at: "2026-02-25T12:00:00Z".to_string(),
            weight: 1.0,
        }
    }

    #[test]
    fn test_keyword_search_returns_matching_entries() {
        let store = SqliteMemoryStore::new_in_memory().unwrap();
        insert_test_project(&store);
        let conn = store.connection();

        store
            .write_entry(&make_entry(
                "e1",
                "Rust error handling uses thiserror for libraries",
                MemoryCategory::Learning,
            ))
            .unwrap();
        store
            .write_entry(&make_entry(
                "e2",
                "Svelte uses runes for reactive state management",
                MemoryCategory::Convention,
            ))
            .unwrap();
        store
            .write_entry(&make_entry(
                "e3",
                "SQLite FTS5 provides full-text search with BM25 ranking",
                MemoryCategory::Context,
            ))
            .unwrap();

        let results = keyword_search(conn, "thiserror", 10).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].id, "e1");
    }

    #[test]
    fn test_keyword_search_respects_limit() {
        let store = SqliteMemoryStore::new_in_memory().unwrap();
        insert_test_project(&store);
        let conn = store.connection();

        // Write 5 entries all containing the word "testing".
        for i in 0..5 {
            store
                .write_entry(&make_entry(
                    &format!("limit-{i}"),
                    &format!("Entry {i} about testing patterns"),
                    MemoryCategory::Learning,
                ))
                .unwrap();
        }

        let results = keyword_search(conn, "testing", 2).unwrap();
        assert_eq!(results.len(), 2);
    }

    #[test]
    fn test_keyword_search_returns_empty_for_no_match() {
        let store = SqliteMemoryStore::new_in_memory().unwrap();
        insert_test_project(&store);
        let conn = store.connection();

        store
            .write_entry(&make_entry(
                "e1",
                "Rust memory safety guarantees",
                MemoryCategory::Learning,
            ))
            .unwrap();

        let results = keyword_search(conn, "javascript", 10).unwrap();
        assert!(results.is_empty());
    }

    /// BM25 ranks shorter documents higher when term frequency is equal.
    /// Three entries each contain "database" exactly once; the shortest
    /// one must rank first under length-normalised BM25.
    #[test]
    fn test_keyword_search_ranks_shorter_documents_higher_when_term_frequency_is_equal() {
        let store = SqliteMemoryStore::new_in_memory().unwrap();
        insert_test_project(&store);
        let conn = store.connection();

        store
            .write_entry(&make_entry(
                "long",
                "The project uses a database for storage alongside many other components and subsystems and helpers",
                MemoryCategory::Context,
            ))
            .unwrap();
        store
            .write_entry(&make_entry(
                "medium",
                "The project uses a database for storage alongside other components",
                MemoryCategory::Context,
            ))
            .unwrap();
        store
            .write_entry(&make_entry("short", "uses a database", MemoryCategory::Context))
            .unwrap();

        let results = keyword_search(conn, "database", 10).unwrap();
        let ranked_ids: Vec<&str> = results.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(
            ranked_ids,
            vec!["short", "medium", "long"],
            "BM25 should rank by length normalisation when term frequency is equal"
        );
    }

    /// `rust OR async` matches entries containing either term; the entry
    /// containing both terms must rank highest, since BM25 sums the per-term
    /// scores. A regression that disabled the FTS5 query parser (e.g.,
    /// switching to LIKE or single-token matching) would either fail the
    /// query outright or return a different ordering.
    #[test]
    fn test_keyword_search_multi_term_or_ranks_documents_matching_more_terms_higher() {
        let store = SqliteMemoryStore::new_in_memory().unwrap();
        insert_test_project(&store);
        let conn = store.connection();

        store
            .write_entry(&make_entry(
                "both",
                "rust async runtime",
                MemoryCategory::Learning,
            ))
            .unwrap();
        store
            .write_entry(&make_entry(
                "one-async",
                "javascript async patterns",
                MemoryCategory::Learning,
            ))
            .unwrap();
        store
            .write_entry(&make_entry(
                "one-rust",
                "rust ownership rules",
                MemoryCategory::Learning,
            ))
            .unwrap();

        let results = keyword_search(conn, "rust OR async", 10).unwrap();
        assert_eq!(results.len(), 3, "all three entries match at least one term");
        assert_eq!(
            results[0].id, "both",
            "the entry matching both terms must rank first"
        );
    }

    /// Phrase matching with double quotes is a documented FTS5 query feature.
    /// "rust async" as a phrase should match only adjacent occurrences,
    /// excluding entries where the words appear separately.
    #[test]
    fn test_keyword_search_phrase_match_with_quotes_requires_adjacency() {
        let store = SqliteMemoryStore::new_in_memory().unwrap();
        insert_test_project(&store);
        let conn = store.connection();

        store
            .write_entry(&make_entry(
                "adjacent",
                "the rust async runtime is fast",
                MemoryCategory::Learning,
            ))
            .unwrap();
        store
            .write_entry(&make_entry(
                "separated",
                "rust handles concurrency with async tasks",
                MemoryCategory::Learning,
            ))
            .unwrap();

        let results = keyword_search(conn, "\"rust async\"", 10).unwrap();
        let ids: Vec<&str> = results.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["adjacent"],
            "phrase match must require the two terms to be adjacent"
        );
    }

    /// Prefix matching with `*` is a documented FTS5 query feature.
    /// `rust*` should match `rustfmt` and `rustacean` but not `crustacean`.
    #[test]
    fn test_keyword_search_prefix_match_with_asterisk_matches_token_prefixes() {
        let store = SqliteMemoryStore::new_in_memory().unwrap();
        insert_test_project(&store);
        let conn = store.connection();

        store
            .write_entry(&make_entry(
                "rustfmt",
                "rustfmt formats rust code",
                MemoryCategory::Convention,
            ))
            .unwrap();
        store
            .write_entry(&make_entry(
                "rustacean",
                "every rustacean writes safe code",
                MemoryCategory::Context,
            ))
            .unwrap();
        store
            .write_entry(&make_entry(
                "crustacean",
                "a crustacean is a type of arthropod",
                MemoryCategory::Context,
            ))
            .unwrap();

        let results = keyword_search(conn, "rust*", 10).unwrap();
        let mut ids: Vec<&str> = results.iter().map(|e| e.id.as_str()).collect();
        ids.sort();
        assert_eq!(
            ids,
            vec!["rustacean", "rustfmt"],
            "prefix match must hit token prefixes only, not substring matches"
        );
    }

    /// Boolean OR is a documented FTS5 query feature.
    #[test]
    fn test_keyword_search_boolean_or_matches_either_term() {
        let store = SqliteMemoryStore::new_in_memory().unwrap();
        insert_test_project(&store);
        let conn = store.connection();

        store
            .write_entry(&make_entry(
                "rust-only",
                "rust ownership model",
                MemoryCategory::Learning,
            ))
            .unwrap();
        store
            .write_entry(&make_entry(
                "go-only",
                "go goroutines and channels",
                MemoryCategory::Learning,
            ))
            .unwrap();
        store
            .write_entry(&make_entry(
                "neither",
                "javascript event loop",
                MemoryCategory::Learning,
            ))
            .unwrap();

        let results = keyword_search(conn, "rust OR go", 10).unwrap();
        let mut ids: Vec<&str> = results.iter().map(|e| e.id.as_str()).collect();
        ids.sort();
        assert_eq!(
            ids,
            vec!["go-only", "rust-only"],
            "OR must match entries containing either term but not entries with neither"
        );
    }

    /// Boolean AND is a documented FTS5 query feature. Implicit AND
    /// (space-separated terms) and explicit AND must produce the same set.
    #[test]
    fn test_keyword_search_boolean_and_requires_both_terms() {
        let store = SqliteMemoryStore::new_in_memory().unwrap();
        insert_test_project(&store);
        let conn = store.connection();

        store
            .write_entry(&make_entry(
                "both",
                "rust async runtime overview",
                MemoryCategory::Learning,
            ))
            .unwrap();
        store
            .write_entry(&make_entry(
                "rust-only",
                "rust borrow checker basics",
                MemoryCategory::Learning,
            ))
            .unwrap();
        store
            .write_entry(&make_entry(
                "async-only",
                "javascript async patterns",
                MemoryCategory::Learning,
            ))
            .unwrap();

        let results = keyword_search(conn, "rust AND async", 10).unwrap();
        let ids: Vec<&str> = results.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(ids, vec!["both"], "AND must require both terms");
    }

    /// Boolean NOT is a documented FTS5 query feature.
    #[test]
    fn test_keyword_search_boolean_not_excludes_documents_containing_excluded_term() {
        let store = SqliteMemoryStore::new_in_memory().unwrap();
        insert_test_project(&store);
        let conn = store.connection();

        store
            .write_entry(&make_entry(
                "rust-without-async",
                "rust ownership rules",
                MemoryCategory::Learning,
            ))
            .unwrap();
        store
            .write_entry(&make_entry(
                "rust-with-async",
                "rust async runtime",
                MemoryCategory::Learning,
            ))
            .unwrap();

        let results = keyword_search(conn, "rust NOT async", 10).unwrap();
        let ids: Vec<&str> = results.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["rust-without-async"],
            "NOT must exclude documents containing the excluded term"
        );
    }

    /// FTS5 sync triggers are the entire subject of ADR-003. The insert
    /// trigger is exercised by every other test through `write_entry`.
    /// This test exercises the delete trigger by removing a row via
    /// direct SQL and verifying it disappears from the search index.
    #[test]
    fn test_delete_trigger_removes_entry_from_fts_index() {
        let store = SqliteMemoryStore::new_in_memory().unwrap();
        insert_test_project(&store);
        let conn = store.connection();

        store
            .write_entry(&make_entry(
                "to-delete",
                "deletable entry about widgets",
                MemoryCategory::Learning,
            ))
            .unwrap();
        store
            .write_entry(&make_entry(
                "kept",
                "kept entry about widgets",
                MemoryCategory::Learning,
            ))
            .unwrap();

        // Confirm both are searchable initially.
        let before = keyword_search(conn, "widgets", 10).unwrap();
        assert_eq!(before.len(), 2);

        // Delete one row directly via SQL — exercises the delete trigger.
        conn.execute(
            "DELETE FROM memory_entries WHERE id = ?1",
            params!["to-delete"],
        )
        .unwrap();

        let after = keyword_search(conn, "widgets", 10).unwrap();
        assert_eq!(after.len(), 1);
        assert_eq!(after[0].id, "kept");
    }

    /// The update trigger should remove the old content from the FTS
    /// index and insert the new content. After update, the new content
    /// is searchable and the old content is not.
    #[test]
    fn test_update_trigger_propagates_content_changes_to_fts_index() {
        let store = SqliteMemoryStore::new_in_memory().unwrap();
        insert_test_project(&store);
        let conn = store.connection();

        store
            .write_entry(&make_entry(
                "to-update",
                "original content about widgets",
                MemoryCategory::Learning,
            ))
            .unwrap();

        // Confirm original content is searchable.
        let before_widgets = keyword_search(conn, "widgets", 10).unwrap();
        assert_eq!(before_widgets.len(), 1);

        // Update the content directly via SQL — exercises the update trigger.
        conn.execute(
            "UPDATE memory_entries SET content = ?1 WHERE id = ?2",
            params!["replacement content about gadgets", "to-update"],
        )
        .unwrap();

        // New content is searchable.
        let after_gadgets = keyword_search(conn, "gadgets", 10).unwrap();
        assert_eq!(after_gadgets.len(), 1);
        assert_eq!(after_gadgets[0].id, "to-update");
        assert_eq!(after_gadgets[0].content, "replacement content about gadgets");

        // Old content is no longer searchable.
        let after_widgets = keyword_search(conn, "widgets", 10).unwrap();
        assert!(
            after_widgets.is_empty(),
            "old content must be removed from the FTS index after update"
        );
    }

    /// After a delete, the FTS index should not return a stale rowid
    /// pointing at a now-missing memory_entries row. If the delete
    /// trigger were broken (wrong column or missing), the JOIN in
    /// keyword_search would either return zero rows (the most likely
    /// failure mode) or surface a SQL error — never a phantom result.
    #[test]
    fn test_keyword_search_does_not_return_stale_rowid_after_delete() {
        let store = SqliteMemoryStore::new_in_memory().unwrap();
        insert_test_project(&store);
        let conn = store.connection();

        store
            .write_entry(&make_entry(
                "ephemeral",
                "this entry will be deleted shortly",
                MemoryCategory::Learning,
            ))
            .unwrap();

        conn.execute(
            "DELETE FROM memory_entries WHERE id = ?1",
            params!["ephemeral"],
        )
        .unwrap();

        // The search must return no results AND must not error from a
        // dangling JOIN against a missing memory_entries row.
        let results = keyword_search(conn, "deleted", 10).unwrap();
        assert!(results.is_empty());
    }
}
