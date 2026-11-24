/**
 * Acceptance: issue #7 — agent identity and PreToolUse scope enforcement.
 *
 * Definition of done: an agent can act only inside the scope its identity
 * declares (files, tools, branch, lifetime), every denial is recorded in the
 * audit trail with the delegation chain back to the human, and calls inside
 * the scope go through untouched.
 *
 * Real stores: a temp project with a real git repository (the hook reads the
 * checked-out branch from its files) and a real JSONL audit file read back
 * from disk. Each test pairs a denial with the matching allowed call — the
 * negative control — so neither a hook that blocks everything nor one that
 * allows everything can pass.
 */

import type { HookJSONOutput, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createScopeEnforcementHook } from '../../src/hooks/scope-enforcement.js';
import { createAgentIdentity } from '../../src/identity/factory.js';
import type { AgentIdentity, AgentScope } from '../../src/identity/types.js';
import { createTempProject, type TempProject } from './support/temp-project.js';

const SCOPED_BRANCH = '7/scope-enforcement';
const SESSION = 'session-acceptance-7';
const HOOK_OPTIONS = { signal: new AbortController().signal };

const NOW = new Date('2026-06-01T12:00:00.000Z');
const ONE_HOUR_MS = 60 * 60 * 1000;

function identityWith(overrides: { scope?: Partial<AgentScope>; expiresAt?: string } = {}): AgentIdentity {
  return createAgentIdentity(
    {
      id: 'agent:code-agent:acceptance-7',
      type: 'specialist',
      role: 'code-agent',
      delegatedBy: 'human:kevin',
      purpose: 'Implement #7',
      scope: {
        issues: ['7'],
        files: ['src/**'],
        branches: [SCOPED_BRANCH],
        tools: ['Read', 'Write'],
        memoryNamespaces: { read: ['context'], write: ['learning'] },
        ...overrides.scope,
      },
      expiresAt: overrides.expiresAt ?? new Date(NOW.getTime() + ONE_HOUR_MS).toISOString(),
    },
    { now: NOW },
  );
}

function permissionDecision(output: HookJSONOutput): string | undefined {
  const specific = (output as { hookSpecificOutput?: { permissionDecision?: string } })
    .hookSpecificOutput;
  return specific?.permissionDecision;
}

describe('#7 identity and scope enforcement', () => {
  let project: TempProject;

  beforeEach(() => {
    project = createTempProject(SCOPED_BRANCH);
  });

  afterEach(() => {
    project.remove();
  });

  /** Run one tool call through the scope hook, exactly as the SDK would. */
  async function attempt(
    identity: AgentIdentity,
    toolName: string,
    toolInput: unknown,
  ): Promise<string | undefined> {
    const hook = createScopeEnforcementHook({
      identity,
      auditLogger: project.auditLogger,
      projectId: 'proj-acceptance',
      now: () => NOW,
    });
    const input: PreToolUseHookInput = {
      hook_event_name: 'PreToolUse',
      session_id: SESSION,
      transcript_path: project.pathOf('transcript.jsonl'),
      cwd: project.root,
      tool_name: toolName,
      tool_input: toolInput,
      tool_use_id: 'tool-use-1',
    };
    return permissionDecision(await hook(input, 'tool-use-1', HOOK_OPTIONS));
  }

  it('denies a write outside the file scope and records it; allows one inside and records nothing', async () => {
    const identity = identityWith();

    // Negative control first: the in-scope write must pass and leave no trace.
    const inScope = await attempt(identity, 'Write', { file_path: project.pathOf('src/a.ts') });
    expect(inScope).toBe('allow');
    expect(project.readAudit()).toEqual([]);

    const outOfScope = await attempt(identity, 'Write', {
      file_path: project.pathOf('docs/b.md'),
    });
    expect(outOfScope).toBe('deny');

    const events = project.readAudit();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: 'scope.violation',
      result: 'blocked',
      agentId: identity.id,
      sessionId: SESSION,
      reason: 'File not in agent scope',
    });
    expect(events[0]!.details.filePath).toBe(project.pathOf('docs/b.md'));
  });

  it('denies a write that escapes the project through a path inside the scope glob', async () => {
    const identity = identityWith();

    expect(
      await attempt(identity, 'Write', { file_path: project.pathOf('src/../../escaped.ts') }),
    ).toBe('deny');
    expect(project.readAudit().map((e) => e.eventType)).toEqual(['scope.violation']);

    // Negative control: the same directory, without the traversal, is allowed.
    expect(
      await attempt(identity, 'Write', { file_path: project.pathOf('src/nested/ok.ts') }),
    ).toBe('allow');
    expect(project.readAudit()).toHaveLength(1);
  });

  it('denies a tool that is not on the allowlist and records tool.blocked; allows a listed tool', async () => {
    const identity = identityWith();

    expect(await attempt(identity, 'Read', { file_path: project.pathOf('src/a.ts') })).toBe(
      'allow',
    );
    expect(project.readAudit()).toEqual([]);

    expect(await attempt(identity, 'WebFetch', { url: 'https://example.com' })).toBe('deny');

    const events = project.readAudit();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ eventType: 'tool.blocked', result: 'blocked' });
    expect(events[0]!.details.tool).toBe('WebFetch');
  });

  it('denies every call once the identity has expired and records credential.expired; allows the same call before expiry', async () => {
    const call = ['Read', { file_path: project.pathOf('src/a.ts') }] as const;

    const live = identityWith();
    expect(await attempt(live, ...call)).toBe('allow');
    expect(project.readAudit()).toEqual([]);

    const expired = identityWith({
      expiresAt: new Date(NOW.getTime() - ONE_HOUR_MS).toISOString(),
    });
    expect(await attempt(expired, ...call)).toBe('deny');

    const events = project.readAudit();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ eventType: 'credential.expired', result: 'blocked' });
  });

  it('denies an in-scope write while another branch is checked out; allows it again on the scoped branch', async () => {
    const identity = identityWith();
    const write = ['Write', { file_path: project.pathOf('src/a.ts') }] as const;

    expect(await attempt(identity, ...write)).toBe('allow');

    project.checkOut('main');
    expect(await attempt(identity, ...write)).toBe('deny');
    const events = project.readAudit();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ eventType: 'scope.violation', result: 'blocked' });
    expect(events[0]!.details.branch).toBe('main');

    project.checkOut(SCOPED_BRANCH);
    expect(await attempt(identity, ...write)).toBe('allow');
    expect(project.readAudit()).toHaveLength(1);
  });

  it('stamps each denial with the delegation chain from the human to the agent', async () => {
    const identity = identityWith();
    expect(identity.delegationChain).toEqual(['human:kevin', 'agent:code-agent:acceptance-7']);

    await attempt(identity, 'Write', { file_path: project.pathOf('docs/b.md') });

    const [event] = project.readAudit();
    expect(event!.delegationChain).toEqual(['human:kevin', 'agent:code-agent:acceptance-7']);
    expect(event!.agentRole).toBe('code-agent');
  });
});
