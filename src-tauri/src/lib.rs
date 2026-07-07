// src-tauri/src/lib.rs
//
// Tauri application entry point and IPC command handler registry. This file
// wires together the backend modules and exposes Tauri commands that the
// Svelte frontend can call via invoke(). Business logic lives in the modules
// below — this file is intentionally thin, acting as the bridge layer.
//
// Module layout:
//   memory/     — SQLite memory store with FTS5 full-text search
//   audit/      — JSONL append-only audit trail
//   identity/   — AgentIdentity types and scope validation
//   references/ — URI scheme resolver for agent reference manifests
//   process/    — Agent sidecar process lifecycle management
//   project/    — App-level registry of known projects
//   commands/   — Tauri IPC command handlers (thin wrappers over the above)
//
// See src-tauri/README.md for the full responsibility breakdown.
// See docs/architecture/sdlc-agent-architecture-research-v4.md Section 2.3
// for the IPC communication flow between frontend, Rust, and agent layer.

use std::path::PathBuf;
use std::sync::Mutex;

use tauri::Manager;

pub mod audit;
pub mod commands;
pub mod identity;
pub mod memory;
pub mod process;
pub mod project;
pub mod references;

use process::manager::AgentProcessManager;
use process::spawner::TauriAgentSpawner;
use project::ProjectRegistry;

/// Resolves the path to the agent layer's entrypoint script that the process
/// manager launches with `node`.
///
/// `SAOR_AGENT_ENTRY` overrides it; otherwise it defaults to
/// `<repo>/agents/dist/sidecar.js`, resolved from this crate's manifest
/// directory (`src-tauri`). Bundling the entrypoint for a packaged app is
/// future work — in development the agent layer is run from its `dist/` build.
fn agent_entry_path() -> PathBuf {
    if let Ok(explicit) = std::env::var("SAOR_AGENT_ENTRY") {
        return PathBuf::from(explicit);
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|repo_root| repo_root.join("agents").join("dist").join("sidecar.js"))
        .unwrap_or_else(|| PathBuf::from("agents/dist/sidecar.js"))
}

/// Scaffold smoke command retained until the real UI (issue #13) replaces the
/// template `+page.svelte`, which still calls it. Not part of the Phase 1
/// command surface.
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {name}! You've been greeted from Rust!")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let handle = app.handle();

            // Open (or create) the app-level project registry in the Tauri
            // app-data directory and manage it as shared state.
            let data_dir = handle
                .path()
                .app_data_dir()
                .map_err(|e| format!("failed to resolve app data directory: {e}"))?;
            let registry = ProjectRegistry::open(&data_dir.join("registry.db"))
                .map_err(|e| format!("failed to open project registry: {e}"))?;
            app.manage(Mutex::new(registry));

            // Build the agent process manager backed by the real Tauri-shell
            // spawner and manage it as shared state.
            let spawner = TauriAgentSpawner::new(handle.clone(), agent_entry_path());
            app.manage(Mutex::new(AgentProcessManager::new(Box::new(spawner))));

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            commands::project::create_project,
            commands::project::get_project,
            commands::project::list_projects,
            commands::memory::memory_write,
            commands::memory::memory_search,
            commands::memory::memory_read,
            commands::audit::audit_get_by_session,
            commands::audit::audit_get_by_agent,
            commands::audit::audit_get_recent,
            commands::agent::agent_start,
            commands::agent::agent_status,
            commands::agent::agent_stop,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
