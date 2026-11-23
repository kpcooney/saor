/**
 * Tests for scope enforcement (issue #7).
 *
 * The pure evaluator (`evaluateToolCall`) and helpers are tested with no SDK
 * dependency. The SDK adapter (`createScopeEnforcementHook`) is tested by
 * invoking the returned callback with a plain PreToolUse input object and a
 * recording AuditLogger double — no real SDK runtime is involved.
 */

import { describe, expect, it, vi } from 'vitest';

import type { BranchState } from '../../src/git/branch-state.js';
import { createAgentIdentity } from '../../src/identity/factory.js';
import type { AgentIdentity, AgentScope } from '../../src/identity/types.js';
import type { AuditEvent, AuditLogger } from '../../src/hooks/audit-logger.js';
import {
  buildScopeViolationEvent,
  createScopeEnforcementHook,
  branchIsInScope,
  evaluateToolCall as evaluateToolCallWithoutDefaults,
  fileIsInScope,
  isCredentialExpired,
  extractReadTargets,
  isProtectedPath,
  matchesGlob,
  type ScopeViolation,
} from '../../src/hooks/scope-enforcement.js';

const NOW = new Date('2026-06-01T12:00:00.000Z');

/** The branch the test identities are scoped to (`branches: ['main']`). */
const ON_SCOPED_BRANCH: BranchState = { kind: 'branch', name: 'main' };

/**
 * `evaluateToolCall` with the scoped branch checked out unless a test says
 * otherwise. Without a branch the evaluator denies every write (fail closed),
 * which would mask what the file-scope and allowlist tests are checking.
 */
function evaluateToolCall(
  input: Parameters<typeof evaluateToolCallWithoutDefaults>[0],
): ReturnType<typeof evaluateToolCallWithoutDefaults> {
  return evaluateToolCallWithoutDefaults({ currentBranch: ON_SCOPED_BRANCH, ...input });
}
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
    // (Reads have their own, wider scope: see the read-scope tests below.)
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
      toolInput: { file_path: 'agents/src/index.ts' },
      now: NOW,
    });

    expect(decision.action).toBe('allow');
  });

  it('blocks every tool call when expiresAt is in the past', () => {
    const decision = evaluateToolCall({
      identity: identityWith({}, PAST),
      toolName: 'Read',
      toolInput: { file_path: 'agents/src/index.ts' },
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
      readCurrentBranch: () => ON_SCOPED_BRANCH,
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
      readCurrentBranch: () => ON_SCOPED_BRANCH,
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
      readCurrentBranch: () => ON_SCOPED_BRANCH,
      now: () => NOW,
    });

    const result = await hook(
      preToolUseInput('Read', { file_path: 'agents/src/index.ts' }),
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
      readCurrentBranch: () => ON_SCOPED_BRANCH,
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
      readCurrentBranch: () => ON_SCOPED_BRANCH,
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
      toolInput: { file_path: 'agents/src/index.ts' },
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

// --- Read scope (issue #56) -------------------------------------------------

const PROJECT_ROOT = '/workspace/saor';

function readDecision(toolName: string, toolInput: unknown, tools = ['Read', 'Grep', 'Glob']) {
  return evaluateToolCall({
    identity: identityWith({ tools }),
    toolName,
    toolInput,
    now: NOW,
    cwd: PROJECT_ROOT,
  });
}

function expectReadBlocked(decision: ReturnType<typeof readDecision>, reason: string): void {
  expect(decision.action).toBe('block');
  if (decision.action !== 'block') return;
  expect(decision.violation.eventType).toBe('scope.violation');
  expect(decision.violation.reason).toBe(reason);
}

const OUTSIDE = 'Read target is outside the project';
const PROTECTED = 'Read target is a protected path';

describe('evaluateToolCall — read scope', () => {
  it('allows reading any ordinary project file, in or out of the write scope', () => {
    for (const filePath of [
      'agents/src/index.ts',
      'docs/adr/001-audit-store-scoping.md',
      `${PROJECT_ROOT}/README.md`,
    ]) {
      expect(readDecision('Read', { file_path: filePath }).action).toBe('allow');
    }
  });

  it('blocks a Read outside the project root', () => {
    for (const filePath of [
      '/etc/passwd',
      '../../.env',
      '/Users/someone/.ssh/id_rsa',
      `${PROJECT_ROOT}/../other-repo/secrets.txt`,
      'src/../../outside.txt',
    ]) {
      expectReadBlocked(readDecision('Read', { file_path: filePath }), OUTSIDE);
    }
  });

  it('blocks a Read of a protected path inside the project', () => {
    for (const filePath of [
      '.env',
      '.env.local',
      'agents/.env',
      '.claude/settings.local.json',
      '.sdlc/memory.db',
      `${PROJECT_ROOT}/.sdlc/audit/2026-06-01.jsonl`,
    ]) {
      expectReadBlocked(readDecision('Read', { file_path: filePath }), PROTECTED);
    }
    // Negative control: look-alike names that are not protected stay readable.
    for (const filePath of ['.envrc', 'docs/env.md', '.claude/settings.json']) {
      expect(readDecision('Read', { file_path: filePath }).action).toBe('allow');
    }
  });

  it('blocks a Read that names no file (fail closed)', () => {
    const decision = readDecision('Read', {});
    expect(decision.action).toBe('block');
    if (decision.action !== 'block') return;
    expect(decision.violation.reason).toBe('File-reading tool call is missing its target path');
  });

  it('holds Grep to the project: its default root is allowed, an outside path is not', () => {
    expect(readDecision('Grep', { pattern: 'TODO' }).action).toBe('allow');
    expect(readDecision('Grep', { pattern: 'TODO', path: 'agents/src' }).action).toBe('allow');
    expectReadBlocked(readDecision('Grep', { pattern: 'BEGIN', path: '/Users/someone/.ssh' }), OUTSIDE);
    expectReadBlocked(readDecision('Grep', { pattern: 'KEY', path: '.sdlc' }), PROTECTED);
  });

  it('checks where a Glob pattern points, not just its path parameter', () => {
    expect(readDecision('Glob', { pattern: '**/*.ts' }).action).toBe('allow');
    expect(readDecision('Glob', { pattern: 'agents/src/**/*.ts' }).action).toBe('allow');
    expectReadBlocked(readDecision('Glob', { pattern: '/etc/**' }), OUTSIDE);
    expectReadBlocked(readDecision('Glob', { pattern: '/*' }), OUTSIDE);
    expectReadBlocked(readDecision('Glob', { pattern: '../**/*.md' }), OUTSIDE);
    expectReadBlocked(readDecision('Glob', { pattern: '*.md', path: '/tmp' }), OUTSIDE);
    expectReadBlocked(readDecision('Glob', { pattern: '.sdlc/**' }), PROTECTED);
    expectReadBlocked(readDecision('Glob', { pattern: '**', path: '.sdlc/audit' }), PROTECTED);
  });

  it('treats an absolute read path as outside when no project root is known', () => {
    const decision = evaluateToolCall({
      identity: identityWith(),
      toolName: 'Read',
      toolInput: { file_path: `${PROJECT_ROOT}/README.md` },
      now: NOW,
    });
    expect(decision.action).toBe('block');
  });

  it('checks read scope before the tool allowlist, like file scope', () => {
    // Even for an agent not granted Read, an outside read is reported as the
    // scope violation it is.
    const decision = readDecision('Read', { file_path: '/etc/passwd' }, ['Write']);
    expectReadBlocked(decision, OUTSIDE);
  });
});

describe('extractReadTargets / isProtectedPath', () => {
  it('names the targets of each file-reading tool', () => {
    expect(extractReadTargets('Read', { file_path: 'a.ts' })).toEqual(['a.ts']);
    expect(extractReadTargets('Read', { file_path: '' })).toBeUndefined();
    expect(extractReadTargets('Grep', { pattern: 'x' })).toEqual(['.']);
    expect(extractReadTargets('Grep', { pattern: 'x', path: 'src' })).toEqual(['src']);
    expect(extractReadTargets('Glob', { pattern: 'src/**/*.ts' })).toEqual(['.', 'src']);
    expect(extractReadTargets('Glob', { pattern: '*.ts', path: 'src' })).toEqual(['src']);
    expect(extractReadTargets('Glob', { pattern: 'lib/*.ts', path: 'src' })).toEqual([
      'src',
      'src/lib',
    ]);
  });

  it('recognizes protected project paths', () => {
    expect(isProtectedPath('.sdlc')).toBe(true);
    expect(isProtectedPath('.sdlc/memory.db')).toBe(true);
    expect(isProtectedPath('packages/api/.env.production')).toBe(true);
    expect(isProtectedPath('src/env.ts')).toBe(false);
  });
});

// --- Bash requires the OS sandbox (issue #56) ---------------------------------

describe('evaluateToolCall — Bash sandbox requirement', () => {
  const bashIdentity = () => identityWith({ tools: ['Read', 'Bash'] });
  const bashCall = { command: 'echo x > docs/notes.md' };

  it('allows Bash when the caller attests the OS sandbox is active', () => {
    const decision = evaluateToolCall({
      identity: bashIdentity(),
      toolName: 'Bash',
      toolInput: bashCall,
      now: NOW,
      isBashSandboxed: true,
    });
    expect(decision.action).toBe('allow');
  });

  it('blocks an allowlisted Bash when the sandbox is absent or unstated', () => {
    for (const isBashSandboxed of [false, undefined]) {
      const decision = evaluateToolCall({
        identity: bashIdentity(),
        toolName: 'Bash',
        toolInput: bashCall,
        now: NOW,
        ...(isBashSandboxed !== undefined ? { isBashSandboxed } : {}),
      });
      expect(decision.action).toBe('block');
      if (decision.action !== 'block') return;
      expect(decision.violation.eventType).toBe('tool.blocked');
      expect(decision.violation.reason).toContain('OS sandbox');
    }
  });

  it('records the blocked Bash attempt through the hook', async () => {
    const { logger, events } = recordingLogger();
    const hook = createScopeEnforcementHook({
      identity: bashIdentity(),
      auditLogger: logger,
      projectId: 'proj-1',
      readCurrentBranch: () => ON_SCOPED_BRANCH,
      isBashSandboxed: false,
      now: () => NOW,
    });

    const result = await hook(preToolUseInput('Bash', bashCall), 'tool-use-1', HOOK_OPTIONS);

    expect(result.hookSpecificOutput).toMatchObject({ permissionDecision: 'deny' });
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe('tool.blocked');
  });
});

// --- Branch scope (issue #58) ------------------------------------------------

describe('evaluateToolCall — branch scope', () => {
  const featureIdentity = () =>
    identityWith({ branches: ['58/*'], tools: ['Read', 'Write', 'Edit', 'Bash'] });
  const write = { file_path: 'agents/src/new.ts' };

  function decide(toolName: string, toolInput: unknown, currentBranch?: BranchState) {
    return evaluateToolCallWithoutDefaults({
      identity: featureIdentity(),
      toolName,
      toolInput,
      now: NOW,
      isBashSandboxed: true,
      ...(currentBranch !== undefined ? { currentBranch } : {}),
    });
  }

  function expectBranchBlocked(decision: ReturnType<typeof decide>, reason: string): void {
    expect(decision.action).toBe('block');
    if (decision.action !== 'block') return;
    expect(decision.violation.eventType).toBe('scope.violation');
    expect(decision.violation.reason).toBe(reason);
    expect(decision.violation.details).toMatchObject({ allowedBranches: ['58/*'] });
  }

  it('allows writes while an in-scope branch is checked out', () => {
    const onFeature: BranchState = { kind: 'branch', name: '58/enforce-branch-scope' };

    expect(decide('Write', write, onFeature).action).toBe('allow');
    expect(decide('Edit', write, onFeature).action).toBe('allow');
    expect(decide('Bash', { command: 'git commit -m x' }, onFeature).action).toBe('allow');
  });

  it('blocks every write-capable tool while an out-of-scope branch is checked out', () => {
    for (const branch of ['main', '59/other-issue', '58']) {
      const elsewhere: BranchState = { kind: 'branch', name: branch };
      for (const [toolName, toolInput] of [
        ['Write', write],
        ['Edit', write],
        ['Bash', { command: 'npm test' }],
      ] as const) {
        const decision = decide(toolName, toolInput, elsewhere);
        expectBranchBlocked(decision, 'Current branch not in agent scope');
        if (decision.action === 'block') {
          expect(decision.violation.details).toMatchObject({ branch });
        }
      }
    }
  });

  it('still allows reads on an out-of-scope branch', () => {
    const onMain: BranchState = { kind: 'branch', name: 'main' };

    expect(decide('Read', { file_path: 'agents/src/index.ts' }, onMain).action).toBe('allow');
  });

  it('blocks writes on a detached HEAD', () => {
    expectBranchBlocked(
      decide('Write', write, { kind: 'detached' }),
      'Repository is in detached HEAD state, so no branch is in agent scope',
    );
  });

  it('blocks writes when the branch is unknown (fail closed)', () => {
    expectBranchBlocked(decide('Write', write), 'Current branch could not be determined');
  });

  it('does not apply to a project that is not a git repository', () => {
    expect(decide('Write', write, { kind: 'none' }).action).toBe('allow');
  });

  it('reports an out-of-scope file before the branch', () => {
    const decision = decide('Write', { file_path: 'docs/x.md' }, { kind: 'branch', name: 'main' });

    expect(decision.action).toBe('block');
    if (decision.action !== 'block') return;
    expect(decision.violation.reason).toBe('File not in agent scope');
  });
});

describe('branchIsInScope', () => {
  it('matches branch names against scope globs', () => {
    expect(branchIsInScope('58/enforce-branch-scope', ['58/*'])).toBe(true);
    expect(branchIsInScope('main', ['main'])).toBe(true);
    expect(branchIsInScope('13/basic-ui', ['*/*'])).toBe(true);
    // `*/*` is "any feature branch": it never matches a single-segment name.
    expect(branchIsInScope('main', ['*/*'])).toBe(false);
    expect(branchIsInScope('58/a/b', ['58/*'])).toBe(false);
    expect(branchIsInScope('580/x', ['58/*'])).toBe(false);
    expect(branchIsInScope('main', [])).toBe(false);
  });
});

describe('createScopeEnforcementHook — branch scope', () => {
  it('reads the branch at every call and audits a write on the wrong branch', async () => {
    const { logger, events } = recordingLogger();
    let checkedOut: BranchState = { kind: 'branch', name: 'main' };
    const directories: string[] = [];
    const hook = createScopeEnforcementHook({
      identity: identityWith(),
      auditLogger: logger,
      projectId: 'proj-2',
      readCurrentBranch: (directory) => {
        directories.push(directory);
        return checkedOut;
      },
      now: () => NOW,
    });
    const call = preToolUseInput('Write', { file_path: 'agents/src/new.ts' });

    const first = await hook(call, 'tool-use-1', HOOK_OPTIONS);
    // The human switches branches mid-run; the next call must see it.
    checkedOut = { kind: 'branch', name: '99/unrelated' };
    const second = await hook(call, 'tool-use-1', HOOK_OPTIONS);

    expect(first.hookSpecificOutput).toMatchObject({ permissionDecision: 'allow' });
    expect(second.hookSpecificOutput).toMatchObject({ permissionDecision: 'deny' });
    expect(directories).toEqual([call.cwd, call.cwd]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: 'scope.violation',
      result: 'blocked',
      details: { branch: '99/unrelated', allowedBranches: ['main'] },
    });
  });
});
