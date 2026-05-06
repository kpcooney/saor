// references/mod.rs
//
// Reference resolver — dereferences the URI schemes used in agent
// reference manifests. When an agent receives a manifest with pointers
// like "standards://coding-standards/typescript" or "file:///docs/adr/001-foo.md",
// it calls the resolve_ref MCP tool, which routes to this module.
//
// This is the Rust-side counterpart to agents/src/mcp/reference-resolver.ts.
// The MCP tool (TypeScript) translates the MCP call into a Tauri IPC invoke,
// which lands here. The resolver handles URI parsing, path-traversal
// validation, and per-scheme dispatch; each scheme has its own resolution
// strategy in resolver.rs.
//
// Phase 1 supports:
//   - file://      Read a file from the project directory
//   - standards:// Walk the two-tier standards override chain
//                  ({project_root}/.sdlc/standards/ then {standards_root}/)
//   - memory://    Run a keyword search against the memory store
//
// tracker:// returns a Phase-3 deferral error rather than falling through
// to UnknownScheme so callers see the deferral explicitly. audit:// is not
// recognised by this module — the audit MCP server (issue #10) will own it.
//
// See docs/architecture/sdlc-agent-architecture-research-v4.md
//   Section 5.4 — resolve_ref tool definition and supported URI schemes
//   Section 4.2 — Three-tier standards model

pub mod resolver;

pub use resolver::{
    resolve_file_uri, resolve_memory_uri, resolve_ref, resolve_standards_uri, ResolvedReference,
    ResolverError,
};
