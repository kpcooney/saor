// commands/project.rs
//
// Project lifecycle IPC commands: create a project (initializes its `.sdlc/`
// tree and registers it), fetch one by id, and list all known projects. The
// registry (`ProjectRegistry`) is the tested unit; these commands are thin
// wrappers that lock the shared registry and map errors to strings.

use std::path::Path;
use std::sync::Mutex;

use tauri::State;

use crate::project::{ProjectRecord, ProjectRegistry};

/// Shared, lock-guarded project registry held in Tauri managed state.
pub type RegistryState = Mutex<ProjectRegistry>;

/// Creates a project rooted at `path`, initializing its stores and recording
/// it in the registry. Errors (e.g. a path that already holds a project) are
/// returned as readable strings.
#[tauri::command]
pub fn create_project(
    registry: State<'_, RegistryState>,
    name: String,
    path: String,
    description: Option<String>,
) -> Result<ProjectRecord, String> {
    let registry = registry.lock().map_err(|e| e.to_string())?;
    registry
        .create(
            &name,
            Path::new(&path),
            description.as_deref().unwrap_or(""),
        )
        .map_err(|e| e.to_string())
}

/// Returns the project with the given id, or an error if it is not known.
#[tauri::command]
pub fn get_project(
    registry: State<'_, RegistryState>,
    id: String,
) -> Result<ProjectRecord, String> {
    let registry = registry.lock().map_err(|e| e.to_string())?;
    registry.get(&id).map_err(|e| e.to_string())
}

/// Returns all registered projects, newest first.
#[tauri::command]
pub fn list_projects(registry: State<'_, RegistryState>) -> Result<Vec<ProjectRecord>, String> {
    let registry = registry.lock().map_err(|e| e.to_string())?;
    registry.list().map_err(|e| e.to_string())
}
