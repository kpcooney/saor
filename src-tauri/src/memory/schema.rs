// memory/schema.rs
//
// SQL schema definitions and Rust types for the memory store. Contains
// CREATE TABLE statements for: projects, agent_sessions, memory_entries,
// and the memory_fts FTS5 virtual table. Also contains the migration
// logic that runs on database open to bring the schema up to date.
//
// FTS5 is SQLite's built-in full-text search extension. The memory_fts
// table is a content table backed by memory_entries, indexed on the
// content and category columns. The FTS index is kept in sync via
// SQLite triggers (see ADR-003 for the rationale behind triggers vs
// explicit Rust-side sync). Vector search (sqlite-vec) is deferred
// to Phase 4 and does not appear here.
//
// See docs/architecture/sdlc-agent-architecture-research-v4.md Section 6.3
// for the full schema with field-level documentation.

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Errors that can occur in memory store operations.
#[derive(Debug, Error)]
pub enum MemoryError {
    #[error("database error: {0}")]
    Database(#[from] rusqlite::Error),

    #[error("entry not found: {0}")]
    NotFound(String),

    #[error("invalid category: {0}")]
    InvalidCategory(String),

    /// The `metadata` column for an entry could not be parsed as JSON.
    /// Indicates corruption (partial write, external write to the DB, or
    /// migration error) — never the result of a normal write through
    /// SqliteMemoryStore, which serialises a serde_json::Value that
    /// always produces valid JSON.
    #[error("invalid metadata for entry {id}: {source}")]
    InvalidMetadata {
        id: String,
        #[source]
        source: serde_json::Error,
    },
}

/// Categories for memory entries. Each category serves a distinct purpose
/// in the agent knowledge system.
///
/// - `Learning`: Patterns that worked, mistakes to avoid, corrections made
/// - `Convention`: Project conventions discovered or established by agents
/// - `Context`: Cross-cutting knowledge that doesn't belong to a specific file or issue
/// - `Index`: Searchable index entries that complement the reference manifest system
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MemoryCategory {
    Learning,
    Convention,
    Context,
    Index,
}

impl std::fmt::Display for MemoryCategory {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MemoryCategory::Learning => write!(f, "learning"),
            MemoryCategory::Convention => write!(f, "convention"),
            MemoryCategory::Context => write!(f, "context"),
            MemoryCategory::Index => write!(f, "index"),
        }
    }
}

/// A single memory entry representing agent knowledge persisted across sessions.
///
/// Memory entries are the atomic unit of the knowledge store. They are created
/// by agents via MCP tools and searchable via FTS5 keyword search. Each entry
/// carries traceability back to the agent that created it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryEntry {
    /// Unique identifier for this entry (UUID v4).
    pub id: String,

    /// Project this entry belongs to.
    pub project_id: String,

    /// Category classifying the type of knowledge stored.
    pub category: MemoryCategory,

    /// The actual content — agent learnings, context notes, index entries, etc.
    pub content: String,

    /// Optional structured metadata (tool parameters, file paths, etc.).
    pub metadata: serde_json::Value,

    /// Agent identity ID of the agent that created this entry.
    pub created_by: String,

    /// ISO 8601 timestamp of when this entry was created.
    pub created_at: String,

    /// Relevance weight for search ranking. Defaults to 1.0, decays over time.
    pub weight: f64,
}

/// Creates all tables, the FTS5 virtual table, and FTS sync triggers.
///
/// This function is idempotent — calling it multiple times on an already-
/// initialized database has no effect and produces no errors. All CREATE
/// statements use IF NOT EXISTS.
///
/// The FTS5 index is kept in sync with memory_entries via three SQLite
/// triggers (insert, delete, update). This is SQLite's prescribed pattern
/// for content tables and ensures the index never drifts out of sync,
/// regardless of how entries are written. See ADR-003 for the rationale.
pub fn initialize_schema(conn: &Connection) -> Result<(), MemoryError> {
    // Enable foreign key enforcement. SQLite has foreign keys disabled
    // by default; we enable them explicitly for data integrity.
    conn.execute_batch("PRAGMA foreign_keys = ON;")?;

    conn.execute_batch(
        "
        -- Project state
        CREATE TABLE IF NOT EXISTS projects (
            id TEXT PRIMARY KEY,
            name TEXT,
            description TEXT,
            created_at TEXT,
            config TEXT
        );

        -- Agent sessions and state
        CREATE TABLE IF NOT EXISTS agent_sessions (
            id TEXT PRIMARY KEY,
            project_id TEXT REFERENCES projects(id),
            agent_id TEXT,
            agent_type TEXT,
            session_id TEXT,
            status TEXT,
            created_at TEXT,
            updated_at TEXT
        );

        -- Memory entries (learnings, cross-cutting knowledge)
        CREATE TABLE IF NOT EXISTS memory_entries (
            id TEXT PRIMARY KEY,
            project_id TEXT REFERENCES projects(id),
            category TEXT,
            content TEXT,
            metadata TEXT,
            created_by TEXT,
            created_at TEXT,
            weight REAL DEFAULT 1.0
        );

        -- FTS5 full-text search index over memory_entries.
        -- content='memory_entries' binds the FTS table to the content table.
        -- content_rowid='rowid' maps FTS rowids to memory_entries rowids.
        -- BM25 ranking is available natively via the rank column.
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
            content,
            category,
            content='memory_entries',
            content_rowid='rowid'
        );

        -- FTS sync triggers: keep memory_fts in sync with memory_entries.
        -- These are SQLite's prescribed mechanism for content table FTS indexes.
        -- See ADR-003 for why triggers were chosen over explicit Rust-side sync.

        -- After INSERT: add the new row to the FTS index.
        CREATE TRIGGER IF NOT EXISTS memory_fts_insert
        AFTER INSERT ON memory_entries BEGIN
            INSERT INTO memory_fts(rowid, content, category)
            VALUES (new.rowid, new.content, new.category);
        END;

        -- After DELETE: remove the old row from the FTS index.
        -- The 'delete' command is FTS5's mechanism for removing entries.
        CREATE TRIGGER IF NOT EXISTS memory_fts_delete
        AFTER DELETE ON memory_entries BEGIN
            INSERT INTO memory_fts(memory_fts, rowid, content, category)
            VALUES ('delete', old.rowid, old.content, old.category);
        END;

        -- After UPDATE: remove old values, insert new values.
        CREATE TRIGGER IF NOT EXISTS memory_fts_update
        AFTER UPDATE ON memory_entries BEGIN
            INSERT INTO memory_fts(memory_fts, rowid, content, category)
            VALUES ('delete', old.rowid, old.content, old.category);
            INSERT INTO memory_fts(rowid, content, category)
            VALUES (new.rowid, new.content, new.category);
        END;
        ",
    )?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_initialize_schema_is_idempotent() {
        let conn = Connection::open_in_memory().unwrap();
        // First call creates everything.
        initialize_schema(&conn).unwrap();
        // Second call should succeed without error — all statements use IF NOT EXISTS.
        initialize_schema(&conn).unwrap();
    }

    #[test]
    fn test_memory_category_serializes_to_lowercase() {
        assert_eq!(
            serde_json::to_string(&MemoryCategory::Learning).unwrap(),
            "\"learning\""
        );
        assert_eq!(
            serde_json::to_string(&MemoryCategory::Convention).unwrap(),
            "\"convention\""
        );
        assert_eq!(
            serde_json::to_string(&MemoryCategory::Context).unwrap(),
            "\"context\""
        );
        assert_eq!(
            serde_json::to_string(&MemoryCategory::Index).unwrap(),
            "\"index\""
        );
    }
}
