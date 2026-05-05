// audit/mod.rs
//
// JSONL-based audit store. Provides an append-only event log capturing
// agent lifecycle events, tool invocations, scope violations, and routing
// decisions. The audit trail is populated automatically by hooks — agents
// do not opt in or out of auditing.
//
// Phase 1 uses per-day JSONL files (ADR-001) for human-readability and
// debuggability. A SQLite-backed implementation can be substituted later
// without changing the interface or the hook layer that writes to it.
//
// See docs/architecture/sdlc-agent-architecture-research-v4.md Section 8
// for the audit trail design, event schema, and abstraction interface.

pub mod schema;
pub mod store;

// Re-export the public API for ergonomic imports.
pub use schema::{AuditError, AuditEvent, AuditEventType, AuditResult};
pub use store::FileSystemAuditStore;
