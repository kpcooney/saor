// project/registry.rs
//
// ProjectRegistry — the app-level index of known projects, backed by a
// single SQLite database (`registry.db`) in the Tauri app-data directory.
//
// Creating a project does three things atomically from the caller's view:
// it initializes the project's own stores (`.sdlc/memory.db` and the audit
// directory), registers the project inside that memory database (so
// memory-entry foreign keys resolve), and records the project in this
// app-level registry. The `path` column is UNIQUE, so a path holds at most
// one project — re-creating onto an occupied path is refused rather than
// clobbering the existing one.
//
// The registry is tested directly with an in-memory database and temp-dir
// project paths (see the tests below and src-tauri/tests/ipc_commands.rs).
//
// See docs/adr/008-project-registry.md for the design rationale.

use std::path::{Path, PathBuf};

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

use crate::audit::FileSystemAuditStore;
use crate::memory::SqliteMemoryStore;

/// Errors produced by registry operations.
#[derive(Debug, Error)]
pub enum ProjectError {
    #[error("registry database error: {0}")]
    Database(#[from] rusqlite::Error),

    #[error("project not found: {0}")]
    NotFound(String),

    #[error("a project already exists at path: {0}")]
    PathAlreadyExists(String),

    #[error("invalid project path: {0}")]
    InvalidPath(String),

    #[error("failed to initialize project memory store: {0}")]
    Memory(#[from] crate::memory::MemoryError),

    #[error("failed to initialize project audit store: {0}")]
    Audit(#[from] crate::audit::AuditError),
}

/// A project record as stored in the registry and returned across IPC.
/// camelCase to match the TypeScript/JSON shape the frontend consumes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRecord {
    /// Unique project identifier (UUID v4).
    pub id: String,
    /// Human-readable project name.
    pub name: String,
    /// Absolute path to the project root (the directory holding `.sdlc/`).
    pub path: String,
    /// Optional free-text description (empty string when none).
    pub description: String,
    /// ISO 8601 timestamp of when the project was created.
    pub created_at: String,
}

/// SQLite-backed index of known projects.
pub struct ProjectRegistry {
    conn: Connection,
}

impl ProjectRegistry {
    /// Opens (or creates) the registry database at `db_path`, creating parent
    /// directories and the schema. Idempotent — safe on an existing registry.
    pub fn open(db_path: &Path) -> Result<Self, ProjectError> {
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                ProjectError::InvalidPath(format!(
                    "failed to create registry directory {}: {e}",
                    parent.display()
                ))
            })?;
        }
        let conn = Connection::open(db_path)?;
        Self::initialize(&conn)?;
        Ok(Self { conn })
    }

    /// Creates an in-memory registry for testing.
    pub fn open_in_memory() -> Result<Self, ProjectError> {
        let conn = Connection::open_in_memory()?;
        Self::initialize(&conn)?;
        Ok(Self { conn })
    }

    fn initialize(conn: &Connection) -> Result<(), ProjectError> {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS projects (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                path TEXT NOT NULL UNIQUE,
                description TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL
            );",
        )?;
        Ok(())
    }

    /// Registers a new project and initializes its on-disk stores.
    ///
    /// Refuses (without clobbering) if the path is already registered here or
    /// if an initialized project already exists on disk at that path. On
    /// success the project's `.sdlc/memory.db` and audit directory exist, the
    /// project is registered inside its own memory database, and a row is
    /// recorded in this registry.
    pub fn create(
        &self,
        name: &str,
        project_path: &Path,
        description: &str,
    ) -> Result<ProjectRecord, ProjectError> {
        let path_str = project_path.to_string_lossy().to_string();

        if project_path.exists() && !project_path.is_dir() {
            return Err(ProjectError::InvalidPath(format!(
                "{path_str} exists and is not a directory"
            )));
        }

        // Refuse a path already registered here, or one that already holds an
        // initialized project on disk — never reinitialize over existing data.
        if self.find_by_path(&path_str)?.is_some() {
            return Err(ProjectError::PathAlreadyExists(path_str));
        }
        let memory_db = project_path.join(".sdlc").join("memory.db");
        if memory_db.exists() {
            return Err(ProjectError::PathAlreadyExists(path_str));
        }

        let id = Uuid::new_v4().to_string();
        let created_at = Utc::now().to_rfc3339();

        // Initialize the project's own stores, then register the project
        // inside its memory database so memory-entry foreign keys resolve.
        let memory = SqliteMemoryStore::new(&memory_db)?;
        memory.register_project(&id, name, description, &created_at)?;
        FileSystemAuditStore::new(project_path)?;

        self.conn.execute(
            "INSERT INTO projects (id, name, path, description, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, name, path_str, description, created_at],
        )?;

        Ok(ProjectRecord {
            id,
            name: name.to_string(),
            path: path_str,
            description: description.to_string(),
            created_at,
        })
    }

    /// Returns the project with the given id, or `NotFound`.
    pub fn get(&self, id: &str) -> Result<ProjectRecord, ProjectError> {
        self.conn
            .query_row(
                "SELECT id, name, path, description, created_at FROM projects WHERE id = ?1",
                params![id],
                row_to_record,
            )
            .optional()?
            .ok_or_else(|| ProjectError::NotFound(id.to_string()))
    }

    /// Returns all registered projects, newest first.
    pub fn list(&self) -> Result<Vec<ProjectRecord>, ProjectError> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, path, description, created_at FROM projects
             ORDER BY created_at DESC",
        )?;
        let records = stmt
            .query_map([], row_to_record)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(records)
    }

    /// Resolves a project id to its root path, or `NotFound`. Used by the
    /// memory/audit/agent commands to locate a project's stores.
    pub fn path_for(&self, id: &str) -> Result<PathBuf, ProjectError> {
        Ok(PathBuf::from(self.get(id)?.path))
    }

    fn find_by_path(&self, path: &str) -> Result<Option<ProjectRecord>, ProjectError> {
        Ok(self
            .conn
            .query_row(
                "SELECT id, name, path, description, created_at FROM projects WHERE path = ?1",
                params![path],
                row_to_record,
            )
            .optional()?)
    }
}

fn row_to_record(row: &rusqlite::Row<'_>) -> Result<ProjectRecord, rusqlite::Error> {
    Ok(ProjectRecord {
        id: row.get(0)?,
        name: row.get(1)?,
        path: row.get(2)?,
        description: row.get(3)?,
        created_at: row.get(4)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Creates a registry plus a temp dir to host projects.
    fn setup() -> (ProjectRegistry, tempfile::TempDir) {
        (
            ProjectRegistry::open_in_memory().unwrap(),
            tempfile::tempdir().unwrap(),
        )
    }

    #[test]
    fn test_create_project_initializes_sdlc_tree_and_returns_record() {
        let (registry, tmp) = setup();
        let project_path = tmp.path().join("my-project");

        let record = registry
            .create("My Project", &project_path, "a test project")
            .unwrap();

        assert_eq!(record.name, "My Project");
        assert_eq!(record.path, project_path.to_string_lossy());
        assert!(!record.id.is_empty());
        // The .sdlc tree exists on disk.
        assert!(project_path.join(".sdlc").join("memory.db").exists());
        assert!(project_path.join(".sdlc").join("audit").is_dir());
    }

    #[test]
    fn test_get_and_list_return_created_projects() {
        let (registry, tmp) = setup();
        let a = registry.create("A", &tmp.path().join("a"), "").unwrap();
        let b = registry.create("B", &tmp.path().join("b"), "").unwrap();

        assert_eq!(registry.get(&a.id).unwrap(), a);
        let all = registry.list().unwrap();
        assert_eq!(all.len(), 2);
        let ids: Vec<&str> = all.iter().map(|r| r.id.as_str()).collect();
        assert!(ids.contains(&a.id.as_str()));
        assert!(ids.contains(&b.id.as_str()));
    }

    #[test]
    fn test_get_unknown_project_returns_not_found() {
        let (registry, _tmp) = setup();
        match registry.get("nope").unwrap_err() {
            ProjectError::NotFound(id) => assert_eq!(id, "nope"),
            other => panic!("expected NotFound, got {other:?}"),
        }
    }

    #[test]
    fn test_create_onto_registered_path_is_refused_without_clobbering() {
        let (registry, tmp) = setup();
        let project_path = tmp.path().join("proj");
        let first = registry.create("First", &project_path, "original").unwrap();

        // Second create at the same path must error.
        let err = registry
            .create("Second", &project_path, "overwrite attempt")
            .unwrap_err();
        assert!(matches!(err, ProjectError::PathAlreadyExists(_)));

        // The original record is intact — not clobbered.
        assert_eq!(registry.get(&first.id).unwrap().name, "First");
        assert_eq!(registry.list().unwrap().len(), 1);
    }

    #[test]
    fn test_create_onto_path_with_existing_sdlc_is_refused() {
        // A project initialized on disk by another registry must not be
        // reinitialized/registered — the on-disk check catches it.
        let (registry, tmp) = setup();
        let project_path = tmp.path().join("shared");
        // Simulate a pre-existing project on disk without a registry row.
        SqliteMemoryStore::new(&project_path.join(".sdlc").join("memory.db")).unwrap();

        let err = registry.create("Shared", &project_path, "").unwrap_err();
        assert!(matches!(err, ProjectError::PathAlreadyExists(_)));
    }
}
