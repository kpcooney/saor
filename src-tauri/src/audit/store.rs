// audit/store.rs
//
// FileSystemAuditStore — the Phase 1 implementation of the audit store,
// writing append-only JSONL files. Each line is a serialized AuditEvent.
// The store supports basic query operations (by agent, by issue, by session)
// by reading and filtering the JSONL files. For Phase 1 project scale,
// this is fast enough; for larger audit histories, the SqliteAuditStore
// will take over without changing the calling code.
//
// JSONL files are written to {project_path}/.sdlc/audit/. The file naming
// granularity (per-day vs per-session) is determined by the ADR for this
// module.
//
// See docs/architecture/sdlc-agent-architecture-research-v4.md Section 8.4
// for the FileSystemAuditStore design and the SqliteAuditStore upgrade path.

// Implementation coming in Phase 1 audit store work.
