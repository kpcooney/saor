// memory/fts.rs
//
// FTS5 keyword search implementation for the memory store. Wraps SQLite's
// FTS5 full-text search extension to provide fast, ranked search over
// memory_entries. Search results are returned ordered by relevance (BM25
// ranking, which FTS5 provides natively via the rank column).
//
// Semantic/vector search is explicitly deferred to Phase 4. When it is
// added, it will be implemented as a separate search path (sqlite-vec
// virtual table), not a replacement for FTS5. The two will be combined
// via reciprocal rank fusion (RRF) in hybridSearch.
//
// See docs/architecture/sdlc-agent-architecture-research-v4.md Section 6.6
// for the semantic search deferral rationale and the planned upgrade path.

// Implementation coming in Phase 1 memory store work.
