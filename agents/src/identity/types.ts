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

/**
 * The broad category of an agent. Coordinators orchestrate other agents,
 * specialists do scoped SDLC work (code, test, docs), and reviewers audit
 * the output of other agents.
 */
export type AgentType = 'coordinator' | 'specialist' | 'reviewer';

/**
 * Memory namespaces an agent may read from and write to. Namespaces are the
 * memory categories defined by the memory store (e.g. "learning",
 * "convention", "context"). Read and write are separated so an agent can be
 * granted read access to shared context without permission to mutate it.
 */
export interface MemoryNamespaceScope {
  /** Memory categories this agent may read. */
  readonly read: readonly string[];
  /** Memory categories this agent may write. */
  readonly write: readonly string[];
}

/**
 * The boundary of what an agent is permitted to touch. Enforced at runtime by
 * the scope-enforcement PreToolUse hook. Every field is an allowlist: an empty
 * list means "nothing of this kind is permitted".
 *
 * See docs/architecture/sdlc-agent-architecture-research-v4.md Section 7.2.
 */
export interface AgentScope {
  /** Issue-tracker IDs this agent is allowed to act on. */
  readonly issues: readonly string[];
  /** Glob patterns for files the agent may write or edit. */
  readonly files: readonly string[];
  /** Git branches the agent is allowed to work on. */
  readonly branches: readonly string[];
  /** Allowlist of tool names the agent may invoke. */
  readonly tools: readonly string[];
  /** Memory categories the agent may read from and write to. */
  readonly memoryNamespaces: MemoryNamespaceScope;
}

/**
 * Cryptographic credential for an agent. Minimal in Phase 1 ("local" means no
 * cryptographic assertion — identity is asserted by the delegation chain
 * alone). Structured now so the FIDO-like extension in Phase 5 can populate
 * `publicKey` and `attestation` without changing the identity schema.
 *
 * See docs/architecture/sdlc-agent-architecture-research-v4.md Section 7.5.
 */
export interface AgentCredential {
  readonly type: 'local' | 'fido2' | 'mtls';
  readonly publicKey?: string;
  readonly attestation?: Record<string, unknown>;
}

/**
 * The complete, immutable identity of an agent. Constructed by
 * `createAgentIdentity` and carried through the agent's lifetime. The identity
 * fields are `readonly` because an agent must not be able to widen its own
 * scope or rewrite its own delegation chain — doing so would defeat both the
 * security boundary and the audit trail.
 *
 * See docs/architecture/sdlc-agent-architecture-research-v4.md Section 7.2.
 */
export interface AgentIdentity {
  /** Unique, immutable identity, e.g. "agent:code:auth-module:sprint-42". */
  readonly id: string;
  /** Broad category of the agent. */
  readonly type: AgentType;
  /** Specific role, e.g. "code-agent", "test-agent". */
  readonly role: string;

  /** Parent agent or user ID that spawned this agent. */
  readonly delegatedBy: string;
  /** Full delegation chain back to the human, ending with this agent's id. */
  readonly delegationChain: readonly string[];
  /** Why this agent exists, e.g. "Implement PROJ-167: user auth". */
  readonly purpose: string;

  /** Runtime access boundary, enforced by the scope-enforcement hook. */
  readonly scope: AgentScope;

  /** Paths to the standard files that apply to this agent's work. */
  readonly standards: readonly string[];

  /** ISO 8601 timestamp of when the identity was created. */
  readonly createdAt: string;
  /** ISO 8601 timestamp after which the identity is expired and inert. */
  readonly expiresAt: string;

  /** Optional cryptographic credential (Phase 5 extension point). */
  readonly credential?: AgentCredential;
}
