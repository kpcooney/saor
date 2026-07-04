// commands/memory.rs
//
// Memory IPC commands: write an entry, keyword-search, and read one by id.
// Each command resolves the project's memory database via the registry, opens
// the store, and performs the operation. The plain functions below take a
// `&ProjectRegistry` so they can be tested directly against temp-dir stores;
// the `#[tauri::command]` wrappers add only state-locking and error-stringing.

use std::path::PathBuf;

use chrono::Utc;
use serde_json::Value;
use tauri::State;
use uuid::Uuid;

use crate::commands::project::RegistryState;
use crate::memory::{MemoryCategory, MemoryEntry, SqliteMemoryStore};
use crate::project::ProjectRegistry;

/// Default number of results returned by `memory_search` when the caller
/// gives no limit.
const DEFAULT_SEARCH_LIMIT: i64 = 20;

/// Upper bound on `memory_search` results, so a single response's size for the
/// UI stays bounded regardless of the caller-supplied limit.
const MAX_SEARCH_LIMIT: i64 = 100;

/// `created_by` stamped on entries written through the IPC command. These are
/// user-initiated writes from the UI; agent-authored writes (which carry the
/// agent's identity id) arrive via the memory MCP tool once the Node↔Rust
/// storage bridge lands (#59).
const IPC_AUTHOR: &str = "user";

/// Opens the memory store for a project resolved through the registry.
fn open_store(registry: &ProjectRegistry, project_id: &str) -> Result<SqliteMemoryStore, String> {
    let root: PathBuf = registry.path_for(project_id).map_err(|e| e.to_string())?;
    let db_path = root.join(".sdlc").join("memory.db");
    SqliteMemoryStore::new(&db_path).map_err(|e| e.to_string())
}

/// Parses a category string from the frontend into a `MemoryCategory`,
/// returning a readable error for anything outside the known set.
fn parse_category(category: &str) -> Result<MemoryCategory, String> {
    match category {
        "learning" => Ok(MemoryCategory::Learning),
        "convention" => Ok(MemoryCategory::Convention),
        "context" => Ok(MemoryCategory::Context),
        "index" => Ok(MemoryCategory::Index),
        other => Err(format!(
            "invalid memory category \"{other}\": expected one of learning, convention, context, index"
        )),
    }
}

/// Writes a memory entry to the project's store and returns its generated id.
pub fn write(
    registry: &ProjectRegistry,
    project_id: &str,
    category: &str,
    content: &str,
    metadata: Option<Value>,
) -> Result<String, String> {
    let store = open_store(registry, project_id)?;
    let entry = MemoryEntry {
        id: Uuid::new_v4().to_string(),
        project_id: project_id.to_string(),
        category: parse_category(category)?,
        content: content.to_string(),
        metadata: metadata.unwrap_or(Value::Null),
        created_by: IPC_AUTHOR.to_string(),
        created_at: Utc::now().to_rfc3339(),
        weight: 1.0,
    };
    store.write_entry(&entry).map_err(|e| e.to_string())?;
    Ok(entry.id)
}

/// Keyword-searches the project's memory, most relevant first.
///
/// Limit semantics match `audit_get_recent`: `None` uses the default; a given
/// limit is clamped to `[0, MAX_SEARCH_LIMIT]`, so `0` returns an empty list
/// and negatives (which SQLite would otherwise treat as "no limit") are floored
/// to `0` rather than silently returning everything.
pub fn search(
    registry: &ProjectRegistry,
    project_id: &str,
    query: &str,
    limit: Option<i64>,
) -> Result<Vec<MemoryEntry>, String> {
    let store = open_store(registry, project_id)?;
    let limit = limit
        .unwrap_or(DEFAULT_SEARCH_LIMIT)
        .clamp(0, MAX_SEARCH_LIMIT);
    store.search(query, limit).map_err(|e| e.to_string())
}

/// Reads a single memory entry by id, or an error if it does not exist.
pub fn read(
    registry: &ProjectRegistry,
    project_id: &str,
    entry_id: &str,
) -> Result<MemoryEntry, String> {
    let store = open_store(registry, project_id)?;
    store.read_entry(entry_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn memory_write(
    registry: State<'_, RegistryState>,
    project_id: String,
    category: String,
    content: String,
    metadata: Option<Value>,
) -> Result<String, String> {
    let registry = registry.lock().map_err(|e| e.to_string())?;
    write(&registry, &project_id, &category, &content, metadata)
}

#[tauri::command]
pub fn memory_search(
    registry: State<'_, RegistryState>,
    project_id: String,
    query: String,
    limit: Option<i64>,
) -> Result<Vec<MemoryEntry>, String> {
    let registry = registry.lock().map_err(|e| e.to_string())?;
    search(&registry, &project_id, &query, limit)
}

#[tauri::command]
pub fn memory_read(
    registry: State<'_, RegistryState>,
    project_id: String,
    entry_id: String,
) -> Result<MemoryEntry, String> {
    let registry = registry.lock().map_err(|e| e.to_string())?;
    read(&registry, &project_id, &entry_id)
}
