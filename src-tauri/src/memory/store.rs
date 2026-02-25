// memory/store.rs
//
// SqliteMemoryStore — the concrete implementation of the memory store
// interface backed by a single SQLite file per project. Handles CRUD
// operations on memory_entries, delegates FTS5 search to fts.rs, and
// manages the database connection lifecycle.
//
// Schema migrations run on open via the initialize() function. The
// database file lives at {project_path}/.sdlc/memory.db.
//
// See docs/architecture/sdlc-agent-architecture-research-v4.md Section 6.3
// for the schema and Section 6.7 for the abstraction interface design.

// Implementation coming in Phase 1 memory store work.
