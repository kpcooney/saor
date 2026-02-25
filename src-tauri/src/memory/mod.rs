// memory/mod.rs
//
// SQLite-backed memory store with FTS5 full-text search. Provides the
// persistent knowledge layer shared across agent sessions and agent
// boundaries. Agents read and write memory via MCP tools defined in
// agents/src/mcp/memory-server.ts, which call back into this module
// through Tauri IPC commands.
//
// The memory store is NOT the primary store for structured artifacts —
// ADRs live in docs/adr/, code in source control, work items in the
// issue tracker. Memory holds agent learnings, cross-cutting context,
// and a searchable index that complements the reference manifest system.
//
// See docs/architecture/sdlc-agent-architecture-research-v4.md Section 6
// for the memory architecture and schema design.

pub mod schema;
pub mod store;
pub mod fts;
