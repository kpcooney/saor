// identity/mod.rs
//
// Agent identity types and scope validation. Defines the Rust representation
// of AgentIdentity (mirroring the TypeScript interface in agents/src/identity/
// types.ts) and implements the scope enforcement checks used by PreToolUse
// hooks: file glob matching, tool allowlist validation, and temporal expiry.
//
// Scope validation in Rust serves as a second enforcement layer — the primary
// enforcement happens in the TypeScript hook layer (agents/src/hooks/
// scope-enforcement.ts), but critical checks can be repeated here for
// defense-in-depth as the system matures.
//
// See docs/architecture/sdlc-agent-architecture-research-v4.md Section 7
// for the full identity model, delegation chain design, and FIDO extension path.

pub mod scope;
