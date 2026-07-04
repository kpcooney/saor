// project/mod.rs
//
// App-level project registry. The memory and audit stores are scoped to a
// single project (one `.sdlc/` tree per project path), but the desktop app
// also needs to know *which* projects exist — the "known projects" list the
// UI opens. That index has no per-project home, so it lives here: a small
// SQLite database in the Tauri app-data directory, one row per project.
//
// The registry is deliberately an index, not a data store — it holds only
// project metadata (id, name, path, description, created_at), bounded by the
// number of projects a user has created. Agent activity (memory entries,
// audit events, sessions) lives in each project's own `.sdlc/` stores, never
// here.
//
// See docs/adr/008-project-registry.md for why this is a separate app-level
// store, and docs/architecture/sdlc-agent-architecture-research-v4.md
// Section 2.3 for where it sits in the IPC flow.

pub mod registry;

pub use registry::{ProjectError, ProjectRecord, ProjectRegistry};
