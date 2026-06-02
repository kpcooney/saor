/**
 * agents/src/identity/factory.ts
 *
 * Factory functions for constructing AgentIdentity instances. The factory
 * handles populating the delegation chain, setting sensible defaults for
 * temporal bounds (expiresAt), and generating the identity id when the caller
 * does not supply one.
 *
 * Consumers pass a partial identity spec (role, purpose, scope) and receive
 * a complete AgentIdentity ready for use with hooks and audit logging. The
 * factory does not persist the identity — that is the responsibility of the
 * caller (typically the agent process manager).
 *
 * Resolving the three-tier standards override chain is intentionally NOT done
 * here: standards resolution is a separate concern (the reference resolver,
 * issue #9). The caller passes already-resolved standard paths in the spec.
 *
 * See docs/architecture/sdlc-agent-architecture-research-v4.md Section 7.2
 * for the full identity schema and Section 7.3 for delegation chain design.
 */

import { randomUUID } from 'node:crypto';

import type {
  AgentCredential,
  AgentIdentity,
  AgentScope,
  AgentType,
} from './types.js';

/** Default agent lifetime: 24 hours. Agents do not live forever. */
export const DEFAULT_AGENT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * The caller-supplied portion of an agent identity. The factory derives the
 * remaining fields (`id` if absent, `delegationChain`, `createdAt`,
 * `expiresAt`).
 */
export interface AgentIdentitySpec {
  /**
   * Explicit identity id. If omitted, the factory generates one of the form
   * `agent:{role}:{uuid}`. Provide an explicit id when a stable, semantic
   * identifier is desired, e.g. "agent:code:auth-module:sprint-42".
   */
  id?: string;
  type: AgentType;
  role: string;
  /** Parent agent or user ID that is spawning this agent. */
  delegatedBy: string;
  purpose: string;
  scope: AgentScope;
  /** Already-resolved standard file paths. Defaults to an empty list. */
  standards?: readonly string[];
  /**
   * The spawning parent's delegation chain. The new agent's id is appended to
   * it to form this agent's chain. When omitted (a human-initiated agent), the
   * chain becomes `[delegatedBy, id]`.
   */
  parentDelegationChain?: readonly string[];
  /**
   * Explicit expiry as an ISO 8601 string. Overrides `ttlMs` when both are
   * given.
   */
  expiresAt?: string;
  /** Lifetime in milliseconds from creation. Defaults to {@link DEFAULT_AGENT_TTL_MS}. */
  ttlMs?: number;
  credential?: AgentCredential;
}

/**
 * Injectable dependencies, primarily for deterministic tests. In production
 * the defaults (system clock, random UUID) are used.
 */
export interface CreateAgentIdentityOptions {
  /** Current time, used for `createdAt` and the `expiresAt` default. */
  now?: Date;
  /** Identity id generator, used only when the spec omits `id`. */
  generateId?: (spec: AgentIdentitySpec) => string;
}

function defaultGenerateId(spec: AgentIdentitySpec): string {
  return `agent:${spec.role}:${randomUUID()}`;
}

/**
 * Build the full delegation chain for a new agent. The chain always ends with
 * the new agent's own id so that any action can be traced from this agent back
 * to the human at the head of the chain.
 */
function buildDelegationChain(spec: AgentIdentitySpec, id: string): string[] {
  const ancestry = spec.parentDelegationChain ?? [spec.delegatedBy];
  return [...ancestry, id];
}

function resolveExpiresAt(spec: AgentIdentitySpec, createdAt: Date): string {
  if (spec.expiresAt !== undefined) {
    return spec.expiresAt;
  }
  const ttlMs = spec.ttlMs ?? DEFAULT_AGENT_TTL_MS;
  return new Date(createdAt.getTime() + ttlMs).toISOString();
}

/**
 * Construct a complete {@link AgentIdentity} from a partial spec. Derives the
 * id (when absent), delegation chain, and temporal bounds; copies the rest
 * through unchanged.
 *
 * The returned identity is a plain immutable object — the factory does not
 * persist it. Persistence and lifecycle are the caller's responsibility.
 */
export function createAgentIdentity(
  spec: AgentIdentitySpec,
  options: CreateAgentIdentityOptions = {},
): AgentIdentity {
  const now = options.now ?? new Date();
  const generateId = options.generateId ?? defaultGenerateId;

  const id = spec.id ?? generateId(spec);
  const createdAt = now.toISOString();

  const identity: AgentIdentity = {
    id,
    type: spec.type,
    role: spec.role,
    delegatedBy: spec.delegatedBy,
    delegationChain: buildDelegationChain(spec, id),
    purpose: spec.purpose,
    scope: spec.scope,
    standards: spec.standards ?? [],
    createdAt,
    expiresAt: resolveExpiresAt(spec, now),
    // `credential` is optional; only include it when supplied so the field is
    // absent (not `undefined`) on identities without a credential.
    ...(spec.credential !== undefined ? { credential: spec.credential } : {}),
  };

  return identity;
}
