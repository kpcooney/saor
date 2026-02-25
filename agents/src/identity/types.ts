/**
 * agents/src/identity/types.ts
 *
 * TypeScript types for the AgentIdentity schema. Every agent in Saor has
 * a structured identity that includes its role, delegation chain (who created
 * it and why), scope restrictions (which files, tools, and memory namespaces
 * it can access), and the standards that apply to its work.
 *
 * The identity is enforced at runtime by PreToolUse hooks — agents cannot
 * act outside the boundaries declared here. The delegation chain provides
 * a traceable link from any agent action back to the human who initiated
 * the work.
 *
 * The credential field is intentionally minimal now, structured for future
 * FIDO-like cryptographic extension (Phase 5).
 *
 * See docs/architecture/sdlc-agent-architecture-research-v4.md Section 7
 * for the full identity model and delegation chain design.
 */

// Types will be defined here in the Phase 1 agent identity implementation.
