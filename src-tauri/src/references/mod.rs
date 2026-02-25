// references/mod.rs
//
// Reference resolver — dereferences the URI schemes used in agent reference
// manifests. When an agent receives a manifest with pointers like
// "standards://coding-standards/typescript" or "file:///docs/adr/001-foo.md",
// it calls the resolve_ref MCP tool, which routes to this module.
//
// This is the Rust-side counterpart to agents/src/mcp/reference-resolver.ts.
// The MCP tool (TypeScript) translates the MCP call into a Tauri IPC invoke,
// which lands here. The resolver handles the URI parsing and dispatch; each
// scheme has its own resolution strategy in resolver.rs.
//
// See docs/architecture/sdlc-agent-architecture-research-v4.md Section 5.4
// for the full resolver design and supported URI schemes.

pub mod resolver;
