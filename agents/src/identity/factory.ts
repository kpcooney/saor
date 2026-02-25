/**
 * agents/src/identity/factory.ts
 *
 * Factory functions for constructing AgentIdentity instances. The factory
 * handles populating the delegation chain, resolving the applicable standards
 * through the three-tier override chain, and setting sensible defaults for
 * temporal bounds (expiresAt).
 *
 * Consumers pass a partial identity spec (role, purpose, scope) and receive
 * a complete, validated AgentIdentity ready for use with hooks and audit
 * logging. The factory does not persist the identity — that is the
 * responsibility of the caller (typically the agent process manager).
 *
 * See docs/architecture/sdlc-agent-architecture-research-v4.md Section 7.2
 * for the full identity schema and Section 7.3 for delegation chain design.
 */

// Implementation coming in Phase 1 agent identity work.
