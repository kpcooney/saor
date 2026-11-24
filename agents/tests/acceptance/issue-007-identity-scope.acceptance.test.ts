/**
 * agents/tests/acceptance/issue-007-identity-scope.acceptance.test.ts
 *
 * Acceptance: issue #7 — agent identity and PreToolUse scope enforcement.
 *
 * Definition of done: an identity is created with an id, a delegation chain
 * back to the human and a bounded lifetime; an agent can act only inside the
 * scope that identity declares (files, tools, lifetime); every denial is
 * recorded in the audit trail with the delegation chain; and calls inside the
 * scope go through untouched. Branch scope was added by issue #58 and has its
 * own file.
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
import { createAgentIdentity, DEFAULT_AGENT_TTL_MS } from '../../src/identity/factory.js';
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
        tools: ['Read', 'Write', 'Edit'],
        memoryNamespaces: { read: ['context'], write: ['learning'] },
        ...overrides.scope,
      },
      expiresAt: overrides.expiresAt ?? new Date(NOW.getTime() + ONE_HOUR_MS).toISOString(),
    },
    { now: NOW },
  );
}

function permissionDecision(output: HookJSONOutput): string | undefined {
  // `HookJSONOutput` is a union over every hook event and over sync/async
  // results; the scope hook only ever returns the PreToolUse shape, so the
  // one field read here is picked out directly instead of narrowing the union.
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
    project?.remove();
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

  it('denies an Edit outside the file scope the same way; allows one inside', async () => {
    const identity = identityWith();
    const edit = (relativePath: string) =>
      attempt(identity, 'Edit', {
        file_path: project.pathOf(relativePath),
        old_string: 'a',
        new_string: 'b',
      });

    expect(await edit('src/a.ts')).toBe('allow');
    expect(project.readAudit()).toEqual([]);

    expect(await edit('docs/b.md')).toBe('deny');
    expect(project.readAudit().map((e) => e.eventType)).toEqual(['scope.violation']);
  });

  it('denies a write whose path starts inside the scope glob and climbs out with ".."', async () => {
    const identity = identityWith();

    // Built by hand: `path.join` (and so `project.pathOf`) would collapse the
    // ".." segments before the hook ever saw them. Both paths begin with the
    // in-scope `src/` and name a file outside the project.
    const absolute = `${project.root}/src/../../escaped.ts`;
    const relative = 'src/../../escaped.ts';
    expect(absolute).toContain('/src/../../');

    expect(await attempt(identity, 'Write', { file_path: absolute })).toBe('deny');
    expect(await attempt(identity, 'Write', { file_path: relative })).toBe('deny');
    // Climbing out of `src/` but staying in the project is out of scope too.
    expect(await attempt(identity, 'Write', { file_path: 'src/../docs/b.md' })).toBe('deny');
    expect(project.readAudit().map((e) => e.eventType)).toEqual([
      'scope.violation',
      'scope.violation',
      'scope.violation',
    ]);

    // Negative control: ".." that resolves back inside the scope is allowed,
    // so the denials above are about where the path lands, not about "..".
    expect(
      await attempt(identity, 'Write', { file_path: `${project.root}/src/nested/../ok.ts` }),
    ).toBe('allow');
    expect(await attempt(identity, 'Write', { file_path: 'src/nested/../ok.ts' })).toBe('allow');
    expect(project.readAudit()).toHaveLength(3);
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

  it('stamps each denial with the delegation chain from the human to the agent', async () => {
    const identity = identityWith();
    expect(identity.delegationChain).toEqual(['human:kevin', 'agent:code-agent:acceptance-7']);

    await attempt(identity, 'Write', { file_path: project.pathOf('docs/b.md') });

    const [event] = project.readAudit();
    expect(event!.delegationChain).toEqual(['human:kevin', 'agent:code-agent:acceptance-7']);
    expect(event!.agentRole).toBe('code-agent');
  });

  it('creates an identity with a generated id, a chain back to its parent, and a 24-hour lifetime by default', () => {
    const scope = identityWith().scope;
    const spec = {
      type: 'specialist' as const,
      role: 'code-agent',
      delegatedBy: 'agent:coordinator:pm',
      parentDelegationChain: ['human:kevin', 'agent:coordinator:pm'],
      purpose: 'Implement #7',
      scope,
    };

    const first = createAgentIdentity(spec, { now: NOW });
    const second = createAgentIdentity(spec, { now: NOW });

    expect(first.id).toMatch(/^agent:code-agent:.+/);
    expect(first.delegationChain).toEqual(['human:kevin', 'agent:coordinator:pm', first.id]);
    expect(first.createdAt).toBe(NOW.toISOString());
    expect(first.expiresAt).toBe(new Date(NOW.getTime() + DEFAULT_AGENT_TTL_MS).toISOString());
    expect(DEFAULT_AGENT_TTL_MS).toBe(24 * ONE_HOUR_MS);

    // Negative controls: ids are generated per identity, not fixed, and an
    // expiry that is not a date is refused instead of producing an identity
    // that never expires.
    expect(second.id).not.toBe(first.id);
    expect(() => createAgentIdentity({ ...spec, expiresAt: 'not-a-date' })).toThrow(TypeError);
  });
});
