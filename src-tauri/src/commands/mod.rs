// commands/mod.rs
//
// Tauri IPC command handlers — the bridge the Svelte frontend calls via
// `invoke()`. Each `#[tauri::command]` here is intentionally thin: it locks
// the shared state, delegates to a plain module function that does the real
// work against the stores, and maps any domain error to a `String` so the
// frontend receives a readable message rather than a panic.
//
// The plain functions (e.g. `memory::write`, `audit::recent`) take a
// `&ProjectRegistry` and explicit arguments, so they are exercised directly —
// against real temp-dir stores — in src-tauri/tests/ipc_commands.rs, with no
// Tauri runtime involved. Business logic lives here and in the store modules,
// never inline in lib.rs.
//
// See docs/architecture/sdlc-agent-architecture-research-v4.md Section 2.3
// for the frontend↔Rust↔agent IPC flow.

pub mod agent;
pub mod audit;
pub mod memory;
pub mod project;
