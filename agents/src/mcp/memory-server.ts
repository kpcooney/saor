/**
 * agents/src/mcp/memory-server.ts
 *
 * In-process MCP server providing memory access tools to agents. Wraps the
 * Rust-backed SQLite memory store (exposed via Tauri IPC) with three tools:
 *
 *   memory_read   — FTS5 keyword search over memory entries, optionally
 *                   filtered by category (learning, convention, context, index)
 *   memory_write  — Store a new memory entry with category and optional metadata
 *   memory_context — Retrieve a project context summary (active sessions,
 *                   recent learnings, key conventions)
 *
 * Agents call these tools to share knowledge across sessions and agent
 * boundaries. The memory layer is NOT the primary store for structured
 * artifacts — ADRs live in docs/adr/, requirements in docs/, code in source
 * control. Memory stores learnings, cross-cutting context, and the semantic
 * index that complements the reference system.
 *
 * See docs/architecture/sdlc-agent-architecture-research-v4.md Section 6.4
 * for the MCP tool definitions and Section 6.2 for what belongs in memory.
 */

// Implementation coming in Phase 1 MCP server work.
