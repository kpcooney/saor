/**
 * Tests for scope enforcement (issue #7).
 *
 * The pure evaluator (`evaluateToolCall`) and helpers are tested with no SDK
 * dependency. The SDK adapter (`createScopeEnforcementHook`) is tested by
 * invoking the returned callback with a plain PreToolUse input object and a
 * recording AuditLogger double — no real SDK runtime is involved.
 */

import { describe, expect, it, vi } from 'vitest';

import { createAgentIdentity } from '../../src/identity/factory.js';
import type { AgentIdentity, AgentScope } from '../../src/identity/types.js';
import type { AuditEvent, AuditLogger } from '../../src/hooks/audit-logger.js';
import {
  buildScopeViolationEvent,
  createScopeEnforcementHook,
  evaluateToolCall,
  fileIsInScope,
  isCredentialExpired,
  matchesGlob,
  type ScopeViolation,
} from '../../src/hooks/scope-enforcement.js';

const NOW = new Date('2026-06-01T12:00:00.000Z');
const FUTURE = new Date('2026-06-01T18:00:00.000Z').toISOString();
const PAST = new Date('2026-06-01T06:00:00.000Z').toISOString();

function identityWith(scopeOverrides: Partial<AgentScope> = {}, expiresAt = FUTURE): AgentIdentity {
  const scope: AgentScope = {
    issues: ['PROJ-167'],
    files: ['agents/src/**'],
    branches: ['main'],
    tools: ['Read', 'Write', 'Edit'],
    memoryNamespaces: { read: ['context'], write: ['learning'] },
    ...scopeOverrides,
  };
  return createAgentIdentity(
    {
      id: 'agent:code:test',
      type: 'specialist',
      role: 'code-agent',
      delegatedBy: 'human:kevin',
      purpose: 'test',
      scope,
      expiresAt,
    },
    { now: NOW },
  );
}

describe('matchesGlob', () => {
  it('matches a recursive ** directory prefix', () => {
    expect(matchesGlob('agents/src/identity/factory.ts', 'agents/src/**')).toBe(true);
    expect(matchesGlob('agents/src/a.ts', 'agents/src/**')).toBe(true);
  });

  it('does not match outside a ** directory prefix', () => {
    expect(matchesGlob('src-tauri/src/lib.rs', 'agents/src/**')).toBe(false);
  });

  it('confines a single * to one path segment', () => {
    expect(matchesGlob('docs/adr.md', 'docs/*.md')).toBe(true);
    expect(matchesGlob('docs/adr/001.md', 'docs/*.md')).toBe(false);
  });

  it('matches extensions across directories with **\/*', () => {
    expect(matchesGlob('agents/src/a.ts', 'agents/src/**/*.ts')).toBe(true);
    expect(matchesGlob('agents/src/x/y.ts', 'agents/src/**/*.ts')).toBe(true);
    expect(matchesGlob('agents/src/a.js', 'agents/src/**/*.ts')).toBe(false);
  });
});

describe('fileIsInScope', () => {
  const globs = ['agents/src/**'];

  it('allows a file inside the glob', () => {
    expect(fileIsInScope('agents/src/hooks/scope.ts', globs)).toBe(true);
  });

  it('blocks a file outside the glob', () => {
    expect(fileIsInScope('src-tauri/src/lib.rs', globs)).toBe(false);
  });

  it('blocks a path-traversal escape that textually starts in scope', () => {
    // Without normalization "agents/src/../../etc/passwd" would match the
    // "agents/src/**" prefix; normalization collapses it to "etc/passwd".
    expect(fileIsInScope('agents/src/../../etc/passwd', globs)).toBe(false);
  });

  it('blocks an absolute path when no project root is provided', () => {
    expect(fileIsInScope('/etc/passwd', globs)).toBe(false);
  });

  it('resolves an absolute path under cwd to a project-relative one', () => {
    const cwd = '/Users/kevin/saor';
    expect(fileIsInScope('/Users/kevin/saor/agents/src/a.ts', globs, cwd)).toBe(true);
    expect(fileIsInScope('/Users/kevin/saor/src-tauri/lib.rs', globs, cwd)).toBe(false);
  });
});

describe('evaluateToolCall — file scope', () => {
  it('allows a Write to a file inside scope', () => {
    const decision = evaluateToolCall({
      identity: identityWith(),
      toolName: 'Write',
      toolInput: { file_path: 'agents/src/new.ts' },
      now: NOW,
    });

    expect(decision.action).toBe('allow');
  });

  it('blocks a Write to a file outside scope with a scope.violation', () => {
    const decision = evaluateToolCall({
      identity: identityWith(),
      toolName: 'Write',
      toolInput: { file_path: 'src-tauri/src/lib.rs' },
      now: NOW,
    });

    expect(decision.action).toBe('block');
    if (decision.action !== 'block') return;
    expect(decision.violation.eventType).toBe('scope.violation');
    expect(decision.violation.details).toMatchObject({
      tool: 'Write',
      filePath: 'src-tauri/src/lib.rs',
    });
  });

  it('blocks a file-mutating tool with no file_path', () => {
    const decision = evaluateToolCall({
      identity: identityWith(),
      toolName: 'Edit',
      toolInput: {},
      now: NOW,
    });

    expect(decision.action).toBe('block');
    if (decision.action !== 'block') return;
    expect(decision.violation.eventType).toBe('scope.violation');
  });

  it('does not apply file-scope checks to non-mutating tools', () => {
    // Read is allowlisted and not file-mutating, so a path outside the file
    // globs is irrelevant — only Write/Edit are constrained by file scope.
    const decision = evaluateToolCall({
      identity: identityWith(),
      toolName: 'Read',
      toolInput: { file_path: 'src-tauri/src/lib.rs' },
      now: NOW,
    });

    expect(decision.action).toBe('allow');
  });
});

describe('evaluateToolCall — tool allowlist', () => {
  it('allows a tool on the allowlist', () => {
    const decision = evaluateToolCall({
      identity: identityWith({ tools: ['Read', 'Grep'] }),
      toolName: 'Grep',
      toolInput: { pattern: 'foo' },
      now: NOW,
    });

    expect(decision.action).toBe('allow');
  });

  it('blocks a tool not on the allowlist with tool.blocked', () => {
    const decision = evaluateToolCall({
      identity: identityWith({ tools: ['Read'] }),
      toolName: 'Bash',
      toolInput: { command: 'rm -rf /' },
      now: NOW,
    });

    expect(decision.action).toBe('block');
    if (decision.action !== 'block') return;
    expect(decision.violation.eventType).toBe('tool.blocked');
    expect(decision.violation.details).toMatchObject({ tool: 'Bash' });
  });
});

describe('evaluateToolCall — credential expiry', () => {
  it('allows when expiresAt is in the future', () => {
    const decision = evaluateToolCall({
      identity: identityWith({}, FUTURE),
      toolName: 'Read',
      toolInput: {},
      now: NOW,
    });

    expect(decision.action).toBe('allow');
  });

  it('blocks every tool call when expiresAt is in the past', () => {
    const decision = evaluateToolCall({
      identity: identityWith({}, PAST),
      toolName: 'Read',
      toolInput: {},
      now: NOW,
    });

    expect(decision.action).toBe('block');
    if (decision.action !== 'block') return;
    expect(decision.violation.eventType).toBe('credential.expired');
  });
});

describe('buildScopeViolationEvent', () => {
  it('produces a correctly-structured, blocked audit event', () => {
    const identity = identityWith();
    const violation: ScopeViolation = {
      eventType: 'scope.violation',
      action: 'Attempted write to src-tauri/src/lib.rs',
      reason: 'File not in agent scope',
      details: { tool: 'Write', filePath: 'src-tauri/src/lib.rs' },
    };

    const event = buildScopeViolationEvent({
      violation,
      identity,
      projectId: 'proj-1',
      sessionId: 'session-abc',
      id: 'evt-1',
      timestamp: NOW.toISOString(),
    });

    expect(event).toEqual<AuditEvent>({
      id: 'evt-1',
      timestamp: '2026-06-01T12:00:00.000Z',
      projectId: 'proj-1',
      agentId: 'agent:code:test',
      agentRole: 'code-agent',
      delegationChain: ['human:kevin', 'agent:code:test'],
      eventType: 'scope.violation',
      action: 'Attempted write to src-tauri/src/lib.rs',
      details: { tool: 'Write', filePath: 'src-tauri/src/lib.rs' },
      sessionId: 'session-abc',
      result: 'blocked',
      reason: 'File not in agent scope',
    });
  });
});

/** A recording AuditLogger double that captures everything written to it. */
function recordingLogger(): { logger: AuditLogger; events: AuditEvent[] } {
  const events: AuditEvent[] = [];
  return {
    events,
    logger: {
      log: async (event: AuditEvent): Promise<void> => {
        events.push(event);
      },
    },
  };
}

function preToolUseInput(toolName: string, toolInput: unknown) {
  return {
    hook_event_name: 'PreToolUse' as const,
    session_id: 'session-abc',
    transcript_path: '/tmp/transcript',
    cwd: '/Users/kevin/saor',
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: 'tool-use-1',
  };
}

const HOOK_OPTIONS = { signal: new AbortController().signal };

describe('createScopeEnforcementHook', () => {
  it('allows an in-scope tool call and writes no audit event', async () => {
    const { logger, events } = recordingLogger();
    const hook = createScopeEnforcementHook({
      identity: identityWith(),
      auditLogger: logger,
      projectId: 'proj-1',
      now: () => NOW,
    });

    const result = await hook(
      preToolUseInput('Write', { file_path: 'agents/src/new.ts' }),
      'tool-use-1',
      HOOK_OPTIONS,
    );

    expect(result.hookSpecificOutput).toMatchObject({
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
    });
    expect(events).toHaveLength(0);
  });

  it('denies an out-of-scope write and records a scope.violation event', async () => {
    const { logger, events } = recordingLogger();
    const hook = createScopeEnforcementHook({
      identity: identityWith(),
      auditLogger: logger,
      projectId: 'proj-1',
      now: () => NOW,
      generateEventId: () => 'evt-fixed',
    });

    const result = await hook(
      preToolUseInput('Write', { file_path: 'src-tauri/src/lib.rs' }),
      'tool-use-1',
      HOOK_OPTIONS,
    );

    expect(result.hookSpecificOutput).toMatchObject({
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'File not in agent scope',
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: 'evt-fixed',
      eventType: 'scope.violation',
      agentId: 'agent:code:test',
      sessionId: 'session-abc',
      result: 'blocked',
      delegationChain: ['human:kevin', 'agent:code:test'],
    });
  });

  it('denies and records credential.expired when the identity has expired', async () => {
    const { logger, events } = recordingLogger();
    const hook = createScopeEnforcementHook({
      identity: identityWith({}, PAST),
      auditLogger: logger,
      projectId: 'proj-1',
      now: () => NOW,
    });

    const result = await hook(
      preToolUseInput('Read', {}),
      'tool-use-1',
      HOOK_OPTIONS,
    );

    expect(result.hookSpecificOutput).toMatchObject({
      permissionDecision: 'deny',
    });
    expect(events[0]?.eventType).toBe('credential.expired');
  });

  it('ignores non-PreToolUse hook events', async () => {
    const { logger, events } = recordingLogger();
    const logSpy = vi.spyOn(logger, 'log');
    const hook = createScopeEnforcementHook({
      identity: identityWith(),
      auditLogger: logger,
      projectId: 'proj-1',
    });

    const result = await hook(
      // A PostToolUse input should pass through untouched.
      {
        hook_event_name: 'PostToolUse',
        session_id: 'session-abc',
        transcript_path: '/tmp/transcript',
        cwd: '/Users/kevin/saor',
        tool_name: 'Write',
        tool_input: { file_path: 'src-tauri/src/lib.rs' },
        tool_use_id: 'tool-use-1',
        tool_response: {},
        // Cast through unknown: this is intentionally a different hook input
        // shape than the callback's primary PreToolUse case.
      } as unknown as Parameters<typeof hook>[0],
      'tool-use-1',
      HOOK_OPTIONS,
    );

    expect(result).toEqual({});
    expect(logSpy).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);
  });

  it('still denies a blocked call when the audit logger throws', async () => {
    // A logging failure must not turn a denied call into an allowed one —
    // auditing is a side effect, not a gate.
    const throwingLogger: AuditLogger = {
      log: async (): Promise<void> => {
        throw new Error('audit store unavailable');
      },
    };
    const hook = createScopeEnforcementHook({
      identity: identityWith(),
      auditLogger: throwingLogger,
      projectId: 'proj-1',
      now: () => NOW,
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await hook(
      preToolUseInput('Write', { file_path: 'src-tauri/src/lib.rs' }),
      'tool-use-1',
      HOOK_OPTIONS,
    );

    expect(result.hookSpecificOutput).toMatchObject({
      permissionDecision: 'deny',
      permissionDecisionReason: 'File not in agent scope',
    });
    // The failure is surfaced, not swallowed.
    expect(errorSpy).toHaveBeenCalledOnce();
    errorSpy.mockRestore();
  });
});

describe('isCredentialExpired', () => {
  it('is false when expiry is in the future', () => {
    expect(isCredentialExpired(FUTURE, NOW)).toBe(false);
  });

  it('is true when expiry is in the past', () => {
    expect(isCredentialExpired(PAST, NOW)).toBe(true);
  });

  it('is true at the exact expiry instant (inclusive boundary)', () => {
    expect(isCredentialExpired(NOW.toISOString(), NOW)).toBe(true);
  });

  it('fails closed: an unparseable expiry is treated as expired', () => {
    expect(isCredentialExpired('not-a-date', NOW)).toBe(true);
    expect(isCredentialExpired('', NOW)).toBe(true);
  });
});

describe('evaluateToolCall — defense-in-depth on a corrupted identity', () => {
  // A factory-built identity can never carry an invalid expiresAt (the factory
  // throws), but a persisted/round-tripped/hand-built one might. The hook must
  // still fail closed. This identity is constructed directly to bypass the
  // factory's validation.
  const corruptedIdentity: AgentIdentity = {
    id: 'agent:code:corrupt',
    type: 'specialist',
    role: 'code-agent',
    delegatedBy: 'human:kevin',
    delegationChain: ['human:kevin', 'agent:code:corrupt'],
    purpose: 'test',
    scope: {
      issues: [],
      files: ['agents/src/**'],
      branches: ['main'],
      tools: ['Read'],
      memoryNamespaces: { read: [], write: [] },
    },
    standards: [],
    createdAt: NOW.toISOString(),
    expiresAt: 'not-a-date',
  };

  it('blocks with credential.expired when expiresAt is unparseable', () => {
    const decision = evaluateToolCall({
      identity: corruptedIdentity,
      toolName: 'Read',
      toolInput: {},
      now: NOW,
    });

    expect(decision.action).toBe('block');
    if (decision.action !== 'block') return;
    expect(decision.violation.eventType).toBe('credential.expired');
  });
});

describe('evaluateToolCall — file scope covers all file-mutating tools', () => {
  it('blocks an out-of-scope MultiEdit with a scope.violation', () => {
    const decision = evaluateToolCall({
      identity: identityWith({ tools: ['Read', 'MultiEdit'] }),
      toolName: 'MultiEdit',
      toolInput: { file_path: 'src-tauri/src/lib.rs' },
      now: NOW,
    });

    expect(decision.action).toBe('block');
    if (decision.action !== 'block') return;
    expect(decision.violation.eventType).toBe('scope.violation');
    expect(decision.violation.action).toContain('MultiEdit');
  });

  it('blocks an out-of-scope NotebookEdit via its notebook_path param', () => {
    const decision = evaluateToolCall({
      identity: identityWith({ tools: ['Read', 'NotebookEdit'] }),
      toolName: 'NotebookEdit',
      toolInput: { notebook_path: 'src-tauri/notes.ipynb' },
      now: NOW,
    });

    expect(decision.action).toBe('block');
    if (decision.action !== 'block') return;
    expect(decision.violation.eventType).toBe('scope.violation');
    expect(decision.violation.details).toMatchObject({
      filePath: 'src-tauri/notes.ipynb',
    });
  });

  it('allows an in-scope MultiEdit', () => {
    const decision = evaluateToolCall({
      identity: identityWith({ tools: ['Read', 'MultiEdit'] }),
      toolName: 'MultiEdit',
      toolInput: { file_path: 'agents/src/new.ts' },
      now: NOW,
    });

    expect(decision.action).toBe('allow');
  });
});
