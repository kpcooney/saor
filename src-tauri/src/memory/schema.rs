// memory/schema.rs
//
// SQL schema definitions for the memory store. Contains CREATE TABLE
// statements for: projects, agent_sessions, memory_entries, and the
// memory_fts FTS5 virtual table. Also contains the migration logic
// that runs on database open to bring the schema up to date.
//
// FTS5 is SQLite's built-in full-text search extension. The memory_fts
// table is a content table backed by memory_entries, indexed on the
// content and category columns. Vector search (sqlite-vec) is deferred
// to Phase 4 and does not appear here.
//
// See docs/architecture/sdlc-agent-architecture-research-v4.md Section 6.3
// for the full schema with field-level documentation.

// Implementation coming in Phase 1 memory store work.
