// references/resolver.rs
//
// URI scheme resolution strategies. Each supported scheme is handled
// by a dedicated function:
//
//   resolve_file_uri      — reads a file from the project directory,
//                           returning its contents as a string
//   resolve_standards_uri — walks the three-tier standards override chain
//                           (agent-specific → .sdlc/standards/ → standards/)
//                           and returns the content of the first match
//   resolve_memory_uri    — dispatches to the memory store's keyword search
//   resolve_audit_uri     — queries the audit store for an agent or issue
//
// Unknown schemes return an error. The tracker:// scheme is not implemented
// in Phase 1 (that is Phase 3 work).
//
// See docs/architecture/sdlc-agent-architecture-research-v4.md Section 5.4
// for the resolve_ref tool definition and Section 4.2 for the standards
// three-tier resolution model.

// Implementation coming in Phase 1 reference resolver work.
