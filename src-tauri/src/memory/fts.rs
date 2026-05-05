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

    #[test]
    fn test_keyword_search_ranks_by_relevance() {
        let store = SqliteMemoryStore::new_in_memory().unwrap();
        insert_test_project(&store);
        let conn = store.connection();

        // Entry with lower keyword density — "database" appears once.
        store
            .write_entry(&make_entry(
                "low-density",
                "The project uses a database for storage alongside other components",
                MemoryCategory::Context,
            ))
            .unwrap();

        // Entry with higher keyword density — "database" appears multiple times.
        store
            .write_entry(&make_entry(
                "high-density",
                "Database schema for the database layer: the database stores all entries in a database file",
                MemoryCategory::Context,
            ))
            .unwrap();

        let results = keyword_search(conn, "database", 10).unwrap();
        assert_eq!(results.len(), 2);
        // Higher density entry should rank first (more relevant).
        assert_eq!(results[0].id, "high-density");
        assert_eq!(results[1].id, "low-density");
    }
}
