/**
 * Tests for the agent identity factory (issue #7).
 *
 * Pure logic, no SDK dependency: construct identities from specs and verify the
 * derived fields (id, delegation chain, temporal bounds). A fixed clock and a
 * deterministic id generator are injected so timestamps and ids are stable.
 */

import { describe, expect, it } from 'vitest';

import {
  createAgentIdentity,
  DEFAULT_AGENT_TTL_MS,
  type AgentIdentitySpec,
} from '../../src/identity/factory.js';
import type { AgentScope } from '../../src/identity/types.js';

const FIXED_NOW = new Date('2026-06-01T12:00:00.000Z');

const BASE_SCOPE: AgentScope = {
  issues: ['PROJ-167'],
  files: ['agents/src/**'],
  branches: ['7/agent-identity'],
  tools: ['Read', 'Write'],
  memoryNamespaces: { read: ['context'], write: ['learning'] },
};

function specWith(overrides: Partial<AgentIdentitySpec> = {}): AgentIdentitySpec {
  return {
    type: 'specialist',
    role: 'code-agent',
    delegatedBy: 'human:kevin',
    purpose: 'Implement PROJ-167: agent identity',
    scope: BASE_SCOPE,
    ...overrides,
  };
}

describe('createAgentIdentity', () => {
  it('generates an id of the form agent:{role}:{generated} when none is supplied', () => {
    const identity = createAgentIdentity(specWith(), {
      generateId: (spec) => `agent:${spec.role}:generated-1`,
    });

    expect(identity.id).toBe('agent:code-agent:generated-1');
  });

  it('uses an explicit id from the spec verbatim', () => {
    const identity = createAgentIdentity(
      specWith({ id: 'agent:code:auth-module:sprint-42' }),
    );

    expect(identity.id).toBe('agent:code:auth-module:sprint-42');
  });

  it('sets createdAt to the injected clock', () => {
    const identity = createAgentIdentity(specWith(), { now: FIXED_NOW });

    expect(identity.createdAt).toBe('2026-06-01T12:00:00.000Z');
  });

  it('defaults expiresAt to 24 hours after createdAt', () => {
    const identity = createAgentIdentity(specWith(), { now: FIXED_NOW });

    const expected = new Date(FIXED_NOW.getTime() + DEFAULT_AGENT_TTL_MS).toISOString();
    expect(identity.expiresAt).toBe(expected);
    expect(DEFAULT_AGENT_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('honors a custom ttlMs for expiresAt', () => {
    const oneHourMs = 60 * 60 * 1000;
    const identity = createAgentIdentity(specWith({ ttlMs: oneHourMs }), {
      now: FIXED_NOW,
    });

    expect(identity.expiresAt).toBe('2026-06-01T13:00:00.000Z');
  });

  it('honors an explicit expiresAt, overriding ttlMs', () => {
    const identity = createAgentIdentity(
      specWith({ expiresAt: '2027-01-01T00:00:00.000Z', ttlMs: 5000 }),
      { now: FIXED_NOW },
    );

    expect(identity.expiresAt).toBe('2027-01-01T00:00:00.000Z');
  });

  it('builds a delegation chain of [delegatedBy, id] for a human-initiated agent', () => {
    const identity = createAgentIdentity(
      specWith({ id: 'agent:code:x', delegatedBy: 'human:kevin' }),
    );

    expect(identity.delegationChain).toEqual(['human:kevin', 'agent:code:x']);
  });

  it('appends the new id to the parent delegation chain', () => {
    const parentChain = ['human:kevin', 'agent:build-coordinator:proj-100'];
    const identity = createAgentIdentity(
      specWith({
        id: 'agent:code:auth',
        delegatedBy: 'agent:build-coordinator:proj-100',
        parentDelegationChain: parentChain,
      }),
    );

    expect(identity.delegationChain).toEqual([
      'human:kevin',
      'agent:build-coordinator:proj-100',
      'agent:code:auth',
    ]);
  });

  it('defaults standards to an empty list when not supplied', () => {
    const identity = createAgentIdentity(specWith());

    expect(identity.standards).toEqual([]);
  });

  it('omits credential when none is supplied', () => {
    const identity = createAgentIdentity(specWith());

    expect('credential' in identity).toBe(false);
  });

  it('includes credential when supplied', () => {
    const identity = createAgentIdentity(
      specWith({ credential: { type: 'local' } }),
    );

    expect(identity.credential).toEqual({ type: 'local' });
  });

  it('copies through type, role, purpose, and scope unchanged', () => {
    const identity = createAgentIdentity(specWith(), { now: FIXED_NOW });

    expect(identity.type).toBe('specialist');
    expect(identity.role).toBe('code-agent');
    expect(identity.purpose).toBe('Implement PROJ-167: agent identity');
    expect(identity.scope).toBe(BASE_SCOPE);
  });
});
