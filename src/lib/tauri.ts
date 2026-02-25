/**
 * src/lib/tauri.ts
 *
 * Typed wrappers around Tauri's invoke() IPC calls. Rather than scattering
 * raw invoke() calls across components, all backend communication is
 * centralized here with typed request/response interfaces. This makes the
 * IPC boundary explicit and keeps components free of backend coupling.
 *
 * Each function corresponds to a Tauri command handler defined in
 * src-tauri/src/lib.rs. If a command is added to the Rust side, a
 * corresponding typed wrapper should be added here.
 */

// Implementation coming in Phase 1 UI work.
