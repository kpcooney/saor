/**
 * src/lib/types.ts
 *
 * Shared TypeScript types for the frontend layer. These are the data shapes
 * the UI works with — Project, AgentSession, MemoryEntry, AuditEvent — which
 * mirror the structures returned by Tauri IPC commands from the Rust backend.
 *
 * Keep these types aligned with the Rust structs in src-tauri/src/. They are
 * not generated automatically, so they must be updated manually when the
 * backend types change. In a future phase this could be automated via
 * tauri-specta or a similar codegen tool.
 */

// Types will be defined here in Phase 1 UI work.
