// audit/schema.rs
//
// Rust types for audit events. The AuditEvent struct mirrors the TypeScript
// AuditEvent interface defined in agents/src/hooks/audit-logger.ts and must
// be kept in sync manually. Both are serialized to/from JSON at the IPC
// boundary.
//
// AuditEventType is an exhaustive enum covering lifecycle events
// (agent.created, agent.completed), action events (tool.invoked,
// file.write), and security events (scope.violation, credential.expired).
//
// See docs/architecture/sdlc-agent-architecture-research-v4.md Section 8.2
// for the full event schema with field-level documentation.

// Implementation coming in Phase 1 audit store work.
