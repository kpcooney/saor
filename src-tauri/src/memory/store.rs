// memory/store.rs
//
// SqliteMemoryStore — the concrete implementation of the memory store
// backed by a single SQLite file per project. Handles CRUD operations
// on memory_entries and manages the database connection lifecycle.
//
// Schema migrations run on construction via initialize_schema(). The
// database file lives at {project_path}/.sdlc/memory.db. For tests,
// use new_in_memory() which creates a transient in-memory database.
//
// See docs/architecture/sdlc-agent-architecture-research-v4.md Section 6.3
// for the schema and Section 6.7 for the abstraction interface design.

use std::path::Path;

use rusqlite::{params, Connection, Row};

use super::schema::{initialize_schema, MemoryEntry, MemoryError};

/// SQLite-backed memory store. Owns its database connection and provides
/// CRUD operations on memory entries with automatic FTS5 indexing.
///
/// Each project gets a single `.sdlc/memory.db` file. The FTS5 search
/// index is maintained automatically via SQLite triggers — writes to
/// memory_entries are mirrored to the memory_fts index transparently.
pub struct SqliteMemoryStore {
    conn: Connection,
}

impl SqliteMemoryStore {
    /// Opens (or creates) a SQLite database at the given path and
    /// initializes the schema. Idempotent — safe to call on an
    /// already-initialized database.
    pub fn new(db_path: &Path) -> Result<Self, MemoryError> {
        // Ensure parent directories exist.
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                MemoryError::Database(rusqlite::Error::SqliteFailure(
                    rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_CANTOPEN),
                    Some(format!(
                        "failed to create directory {}: {e}",
                        parent.display()
                    )),
                ))
            })?;
        }
        let conn = Connection::open(db_path)?;
        initialize_schema(&conn)?;
        Ok(Self { conn })
    }

    /// Creates an in-memory database for testing. Schema is initialized
    /// but no file is created on disk.
    pub fn new_in_memory() -> Result<Self, MemoryError> {
        let conn = Connection::open_in_memory()?;
        initialize_schema(&conn)?;
        Ok(Self { conn })
    }

    /// Persists a memory entry. The FTS5 index is updated automatically
    /// via the insert trigger defined in schema.rs.
    pub fn write_entry(&self, entry: &MemoryEntry) -> Result<(), MemoryError> {
        // Serialising a serde_json::Value cannot fail — Value is by
        // construction a valid JSON tree. Use expect() to make the
        // invariant explicit rather than substituting a silent fallback.
        let metadata_json = serde_json::to_string(&entry.metadata)
            .expect("serde_json::Value is always serialisable");

        self.conn.execute(
            "INSERT INTO memory_entries (id, project_id, category, content, metadata, created_by, created_at, weight)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                entry.id,
                entry.project_id,
                entry.category.to_string(),
                entry.content,
                metadata_json,
                entry.created_by,
                entry.created_at,
                entry.weight,
            ],
        )?;

        Ok(())
    }

    /// Reads a single memory entry by its ID.
    ///
    /// Returns `MemoryError::NotFound` if no entry with the given ID exists.
    pub fn read_entry(&self, id: &str) -> Result<MemoryEntry, MemoryError> {
        let mut stmt = self.conn.prepare(
            "SELECT id, project_id, category, content, metadata, created_by, created_at, weight
             FROM memory_entries
             WHERE id = ?1",
        )?;

        let entry = stmt
            .query_row(params![id], row_to_entry)
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => MemoryError::NotFound(id.to_string()),
                other => MemoryError::Database(other),
            })?;

        Ok(entry)
    }

    /// Returns a reference to the underlying connection. Used by the
    /// FTS5 search module to run search queries against the same database.
    pub(crate) fn connection(&self) -> &Connection {
        &self.conn
    }
}

/// Deserializes a SQLite row into a MemoryEntry. Used by both store.rs
/// and fts.rs to avoid duplicating the row-mapping logic.
///
/// Expected column order: id, project_id, category, content, metadata,
/// created_by, created_at, weight.
pub(crate) fn row_to_entry(row: &Row<'_>) -> Result<MemoryEntry, rusqlite::Error> {
    let category_str: String = row.get(2)?;
    let category = match category_str.as_str() {
        "learning" => super::schema::MemoryCategory::Learning,
        "convention" => super::schema::MemoryCategory::Convention,
        "context" => super::schema::MemoryCategory::Context,
        "index" => super::schema::MemoryCategory::Index,
        other => {
            return Err(rusqlite::Error::FromSqlConversionFailure(
                2,
                rusqlite::types::Type::Text,
                Box::new(super::schema::MemoryError::InvalidCategory(
                    other.to_string(),
                )),
            ));
        }
    };

    let id: String = row.get(0)?;
    let metadata_str: String = row.get(4)?;
    let metadata: serde_json::Value = serde_json::from_str(&metadata_str).map_err(|source| {
        // Surface the parse failure rather than silently substituting Null,
        // which would mask data corruption. Wrap the MemoryError in a
        // FromSqlConversionFailure so it propagates through the rusqlite
        // query callback path, matching the InvalidCategory pattern above.
        rusqlite::Error::FromSqlConversionFailure(
            4,
            rusqlite::types::Type::Text,
            Box::new(super::schema::MemoryError::InvalidMetadata {
                id: id.clone(),
                source,
            }),
        )
    })?;

    Ok(MemoryEntry {
        id,
        project_id: row.get(1)?,
        category,
        content: row.get(3)?,
        metadata,
        created_by: row.get(5)?,
        created_at: row.get(6)?,
        weight: row.get(7)?,
    })
}

#[cfg(test)]
mod tests {
    use super::super::schema::MemoryCategory;
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

    /// Helper to create a test entry with sensible defaults.
    fn test_entry(id: &str, content: &str) -> MemoryEntry {
        MemoryEntry {
            id: id.to_string(),
            project_id: "test-project".to_string(),
            category: MemoryCategory::Learning,
            content: content.to_string(),
            metadata: serde_json::json!({"source": "test"}),
            created_by: "agent:test:unit-tests".to_string(),
            created_at: "2026-02-25T12:00:00Z".to_string(),
            weight: 1.0,
        }
    }

    #[test]
    fn test_write_entry_and_read_back_returns_all_fields() {
        let store = SqliteMemoryStore::new_in_memory().unwrap();
        insert_test_project(&store);
        let entry = test_entry(
            "entry-001",
            "Rust error handling prefers thiserror for libraries",
        );

        store.write_entry(&entry).unwrap();
        let read_back = store.read_entry("entry-001").unwrap();

        assert_eq!(read_back.id, entry.id);
        assert_eq!(read_back.project_id, entry.project_id);
        assert_eq!(read_back.category, entry.category);
        assert_eq!(read_back.content, entry.content);
        assert_eq!(read_back.metadata, entry.metadata);
        assert_eq!(read_back.created_by, entry.created_by);
        assert_eq!(read_back.created_at, entry.created_at);
        assert!((read_back.weight - entry.weight).abs() < f64::EPSILON);
    }

    #[test]
    fn test_read_nonexistent_entry_returns_not_found() {
        let store = SqliteMemoryStore::new_in_memory().unwrap();
        let result = store.read_entry("does-not-exist");

        assert!(result.is_err());
        match result.unwrap_err() {
            MemoryError::NotFound(id) => assert_eq!(id, "does-not-exist"),
            other => panic!("expected NotFound, got: {other:?}"),
        }
    }

    #[test]
    fn test_write_entry_with_null_metadata() {
        let store = SqliteMemoryStore::new_in_memory().unwrap();
        insert_test_project(&store);
        let mut entry = test_entry("entry-null-meta", "Entry with null metadata");
        entry.metadata = serde_json::Value::Null;

        store.write_entry(&entry).unwrap();
        let read_back = store.read_entry("entry-null-meta").unwrap();

        assert_eq!(read_back.metadata, serde_json::Value::Null);
    }

    #[test]
    fn test_write_entry_with_different_categories() {
        let store = SqliteMemoryStore::new_in_memory().unwrap();
        insert_test_project(&store);

        let categories = [
            ("cat-learning", MemoryCategory::Learning),
            ("cat-convention", MemoryCategory::Convention),
            ("cat-context", MemoryCategory::Context),
            ("cat-index", MemoryCategory::Index),
        ];

        for (id, category) in &categories {
            let mut entry = test_entry(id, "Category test");
            entry.category = category.clone();
            store.write_entry(&entry).unwrap();
        }

        for (id, expected_category) in &categories {
            let read_back = store.read_entry(id).unwrap();
            assert_eq!(&read_back.category, expected_category);
        }
    }

    /// Writing through `write_entry` always produces valid JSON in the
    /// `metadata` column. But if the column is corrupted out-of-band
    /// (partial write, external tool, schema migration error), `read_entry`
    /// must surface the corruption rather than silently substituting null.
    #[test]
    fn test_read_entry_with_invalid_metadata_returns_invalid_metadata_error() {
        let store = SqliteMemoryStore::new_in_memory().unwrap();
        insert_test_project(&store);

        // Insert a row directly via SQL with a metadata value that is not
        // valid JSON. This simulates corruption — the public write_entry
        // API cannot produce this state.
        store
            .connection()
            .execute(
                "INSERT INTO memory_entries (id, project_id, category, content, metadata, created_by, created_at, weight)
                 VALUES ('corrupt-meta', 'test-project', 'learning', 'corrupted entry', 'not valid json', 'agent:test', '2026-02-25T12:00:00Z', 1.0)",
                [],
            )
            .unwrap();

        let result = store.read_entry("corrupt-meta");
        assert!(result.is_err(), "expected InvalidMetadata error, got Ok");

        match result.unwrap_err() {
            MemoryError::Database(rusqlite::Error::FromSqlConversionFailure(
                _,
                _,
                inner,
            )) => match inner.downcast_ref::<MemoryError>() {
                Some(MemoryError::InvalidMetadata { id, .. }) => {
                    assert_eq!(id, "corrupt-meta");
                }
                other => panic!("expected InvalidMetadata, got: {other:?}"),
            },
            other => panic!("expected FromSqlConversionFailure wrapping InvalidMetadata, got: {other:?}"),
        }
    }
}
