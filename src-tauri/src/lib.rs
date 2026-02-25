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
//
// See src-tauri/README.md for the full responsibility breakdown.
// See docs/architecture/sdlc-agent-architecture-research-v4.md Section 2.3
// for the IPC communication flow between frontend, Rust, and agent layer.

pub mod audit;
pub mod identity;
pub mod memory;
pub mod process;
pub mod references;

// Scaffold command from Tauri template — will be replaced with real commands
// as Phase 1 modules are implemented.
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![greet])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
