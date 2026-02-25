/**
 * agents/src/mcp/reference-resolver.ts
 *
 * In-process MCP server providing the resolve_ref tool, which dereferences
 * URI scheme references used in reference manifests. Agents use this to load
 * context on demand rather than receiving pre-packaged summaries.
 *
 * Supported URI schemes:
 *   file://      — Read a file from the project directory
 *   standards:// — Resolve a standards reference through the three-tier chain
 *                  (agent-specific → project overrides → system defaults)
 *   memory://    — Query the memory store (delegates to memory-server)
 *   audit://     — Query the audit trail for an agent or issue
 *   tracker://   — Fetch an issue/epic/initiative (Phase 3, not yet implemented)
 *
 * This is the runtime implementation of the Reference-Based Handoff Protocol —
 * the novel core of the Saor architecture. Agents receive a manifest of URI
 * pointers and pull only what they need, rather than receiving lossy summaries.
 *
 * See docs/architecture/sdlc-agent-architecture-research-v4.md Section 5
 * for the full reference manifest pattern and resolver design.
 */

// Implementation coming in Phase 1 MCP server work.
