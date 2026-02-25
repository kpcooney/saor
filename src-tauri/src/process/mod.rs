// process/mod.rs
//
// Agent process lifecycle management. Responsible for spawning the TypeScript
// agent sidecar as a child process, monitoring its health, and terminating
// it cleanly when a session ends or an error occurs.
//
// The Claude Agent SDK runs the Claude CLI as a subprocess. Tauri's sidecar
// mechanism bundles the CLI binary with the app and provides a typed API for
// launching and communicating with it. This module wraps that API and adds
// session tracking, error handling, and status reporting back to the frontend
// via Tauri events (tauri::AppHandle::emit).
//
// See docs/architecture/sdlc-agent-architecture-research-v4.md Section 2.3
// for the communication flow diagram showing how the frontend, Rust backend,
// and agent layer interact.

pub mod manager;
