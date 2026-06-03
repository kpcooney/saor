/**
 * Tests for the audit-logging PostToolUse hook (issue #10).
 *
 * The pure event builder (`buildToolAuditEvents`) and its helpers are tested
 * with no SDK dependency. The SDK adapter (`createAuditLoggerHook`) is tested by
 * invoking the returned callback with plain PostToolUse / PostToolUseFailure
 * input objects and a recording AuditLogger double — no real SDK runtime is
 * involved.
 */

import { describe, expect, it, vi } from 'vitest';

import { createAgentIdentity } from '../../src/identity/factory.js';
import type { AgentIdentity, AgentScope } from '../../src/identity/types.js';
import {
  buildToolAuditEvents,
  createAuditLoggerHook,
  detectToolResponseFailure,
  resolveIssueRef,
  type AuditEvent,
  type AuditLogger,
} from '../../src/hooks/audit-logger.js';

const NOW = new Date('2026-06-01T12:00:00.000Z');
const FUTURE = new Date('2026-06-01T18:00:00.000Z').toISOString();

function identityWith(scopeOverrides: Partial<AgentScope> = {}): AgentIdentity {
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
      expiresAt: FUTURE,
    },
    { now: NOW },
  );
}

/** A recording AuditLogger double — captures every event written to it. */
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

/** Build a plain PostToolUse (success) input object. */
function postToolUseInput(toolName: string, toolInput: unknown, toolResponse: unknown = {}) {
  return {
    hook_event_name: 'PostToolUse' as const,
    session_id: 'session-abc',
    transcript_path: '/tmp/transcript',
    cwd: '/Users/kevin/saor',
    tool_name: toolName,
    tool_input: toolInput,
    tool_response: toolResponse,
    tool_use_id: 'tool-use-1',
  };
}

/** Build a plain PostToolUseFailure (error) input object. */
function postToolUseFailureInput(toolName: string, toolInput: unknown, error: string) {
  return {
    hook_event_name: 'PostToolUseFailure' as const,
    session_id: 'session-abc',
    transcript_path: '/tmp/transcript',
    cwd: '/Users/kevin/saor',
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: 'tool-use-1',
    error,
  };
}

const HOOK_OPTIONS = { signal: new AbortController().signal };

describe('buildToolAuditEvents', () => {
  const builderBase = {
    identity: identityWith(),
    projectId: 'proj-1',
    sessionId: 'session-abc',
    invokedEventId: 'evt-invoked',
    completedEventId: 'evt-completed',
    timestamp: NOW.toISOString(),
  };

  it('emits a pending tool.invoked event followed by a tool.completed event', () => {
    const [invoked, completed] = buildToolAuditEvents({
      ...builderBase,
      toolName: 'Write',
      toolInput: { file_path: 'agents/src/new.ts', content: 'x' },
      outcome: { result: 'success', response: { ok: true } },
    });

    expect(invoked.eventType).toBe('tool.invoked');
    expect(invoked.result).toBe('pending');
    expect(completed.eventType).toBe('tool.completed');
    expect(completed.result).toBe('success');
  });

  it('records the tool name as the action and the parameters as details', () => {
    const params = { file_path: 'agents/src/new.ts', content: 'hello' };
    const [invoked, completed] = buildToolAuditEvents({
      ...builderBase,
      toolName: 'Write',
      toolInput: params,
      outcome: { result: 'success', response: {} },
    });

    for (const event of [invoked, completed]) {
      expect(event.action).toBe('Write');
      expect(event.details).toEqual({ tool: 'Write', parameters: params });
    }
  });

  it('carries identity, project, and session onto both events', () => {
    const identity = identityWith();
    const [invoked, completed] = buildToolAuditEvents({
      ...builderBase,
      identity,
      toolName: 'Read',
      toolInput: { file_path: 'agents/src/a.ts' },
      outcome: { result: 'success', response: {} },
    });

    for (const event of [invoked, completed]) {
      expect(event.agentId).toBe(identity.id);
      expect(event.agentRole).toBe('code-agent');
      expect(event.delegationChain).toEqual(identity.delegationChain);
      expect(event.projectId).toBe('proj-1');
      expect(event.sessionId).toBe('session-abc');
      expect(event.timestamp).toBe(NOW.toISOString());
    }
    expect(invoked.id).toBe('evt-invoked');
    expect(completed.id).toBe('evt-completed');
  });

  it('puts the error reason on the completed event when the call failed', () => {
    const [invoked, completed] = buildToolAuditEvents({
      ...builderBase,
      toolName: 'Write',
      toolInput: { file_path: 'agents/src/new.ts' },
      outcome: { result: 'failure', reason: 'disk full' },
    });

    expect(completed.result).toBe('failure');
    expect(completed.reason).toBe('disk full');
    // The invocation itself is still recorded as pending, with no reason.
    expect(invoked.result).toBe('pending');
    expect(invoked.reason).toBeUndefined();
  });

  it('stamps the resolved issue reference on both events', () => {
    const [invoked, completed] = buildToolAuditEvents({
      ...builderBase,
      issueRef: 'PROJ-167',
      toolName: 'Read',
      toolInput: {},
      outcome: { result: 'success', response: {} },
    });

    expect(invoked.issueRef).toBe('PROJ-167');
    expect(completed.issueRef).toBe('PROJ-167');
  });

  it('omits issueRef entirely when none is supplied', () => {
    const [invoked] = buildToolAuditEvents({
      ...builderBase,
      toolName: 'Read',
      toolInput: {},
      outcome: { result: 'success', response: {} },
    });

    expect('issueRef' in invoked).toBe(false);
  });

  it('wraps non-object tool input under a value key', () => {
    const [invoked] = buildToolAuditEvents({
      ...builderBase,
      toolName: 'Bash',
      toolInput: 'ls -la',
      outcome: { result: 'success', response: {} },
    });

    expect(invoked.details).toEqual({ tool: 'Bash', parameters: { value: 'ls -la' } });
  });
});

describe('resolveIssueRef', () => {
  it('returns an explicit override when provided', () => {
    expect(resolveIssueRef(identityWith({ issues: ['PROJ-1', 'PROJ-2'] }), 'PROJ-9')).toBe(
      'PROJ-9',
    );
  });

  it('derives the single in-scope issue when no override is given', () => {
    expect(resolveIssueRef(identityWith({ issues: ['PROJ-167'] }))).toBe('PROJ-167');
  });

  it('omits the reference when the scope spans zero or multiple issues', () => {
    expect(resolveIssueRef(identityWith({ issues: [] }))).toBeUndefined();
    expect(resolveIssueRef(identityWith({ issues: ['PROJ-1', 'PROJ-2'] }))).toBeUndefined();
  });
});

describe('detectToolResponseFailure', () => {
  it('returns undefined for a plain successful response', () => {
    expect(detectToolResponseFailure({ content: 'ok' })).toBeUndefined();
    expect(detectToolResponseFailure('done')).toBeUndefined();
    expect(detectToolResponseFailure(null)).toBeUndefined();
  });

  it('extracts the message from an in-band error response', () => {
    expect(detectToolResponseFailure({ is_error: true, error: 'boom' })).toBe('boom');
    expect(detectToolResponseFailure({ isError: true, content: 'nope' })).toBe('nope');
  });

  it('falls back to a generic message when the error flag carries no text', () => {
    expect(detectToolResponseFailure({ is_error: true })).toBe('Tool reported an error');
  });
});

describe('createAuditLoggerHook', () => {
  it('emits a correctly-structured tool.completed event with result success', async () => {
    const { logger, events } = recordingLogger();
    const hook = createAuditLoggerHook({
      identity: identityWith(),
      auditLogger: logger,
      projectId: 'proj-1',
      now: () => NOW,
    });

    const result = await hook(
      postToolUseInput('Write', { file_path: 'agents/src/new.ts' }),
      'tool-use-1',
      HOOK_OPTIONS,
    );

    // PostToolUse auditing never alters the tool flow.
    expect(result).toEqual({});
    expect(events).toHaveLength(2);

    const [invoked, completed] = events;
    expect(invoked.eventType).toBe('tool.invoked');
    expect(invoked.result).toBe('pending');
    expect(completed.eventType).toBe('tool.completed');
    expect(completed.result).toBe('success');
    expect(completed.action).toBe('Write');
    expect(completed.details).toEqual({
      tool: 'Write',
      parameters: { file_path: 'agents/src/new.ts' },
    });
    expect(completed.sessionId).toBe('session-abc');
  });

  it('emits tool.completed with result failure and the error reason on PostToolUseFailure', async () => {
    const { logger, events } = recordingLogger();
    const hook = createAuditLoggerHook({
      identity: identityWith(),
      auditLogger: logger,
      projectId: 'proj-1',
      now: () => NOW,
    });

    await hook(
      postToolUseFailureInput('Write', { file_path: 'agents/src/new.ts' }, 'permission denied'),
      'tool-use-1',
      HOOK_OPTIONS,
    );

    expect(events).toHaveLength(2);
    const completed = events[1];
    expect(completed.eventType).toBe('tool.completed');
    expect(completed.result).toBe('failure');
    expect(completed.reason).toBe('permission denied');
  });

  it('treats an in-band error response on PostToolUse as a failure', async () => {
    const { logger, events } = recordingLogger();
    const hook = createAuditLoggerHook({
      identity: identityWith(),
      auditLogger: logger,
      projectId: 'proj-1',
      now: () => NOW,
    });

    await hook(
      postToolUseInput('Read', { file_path: 'agents/src/a.ts' }, { is_error: true, error: 'nope' }),
      'tool-use-1',
      HOOK_OPTIONS,
    );

    const completed = events[1];
    expect(completed.result).toBe('failure');
    expect(completed.reason).toBe('nope');
  });

  it('sets delegationChain to match the agent identity used', async () => {
    const { logger, events } = recordingLogger();
    const identity = identityWith();
    const hook = createAuditLoggerHook({
      identity,
      auditLogger: logger,
      projectId: 'proj-1',
      now: () => NOW,
    });

    await hook(postToolUseInput('Read', {}), 'tool-use-1', HOOK_OPTIONS);

    for (const event of events) {
      expect(event.delegationChain).toEqual(identity.delegationChain);
      expect(event.agentId).toBe(identity.id);
    }
  });

  it('stamps the derived issue reference on emitted events', async () => {
    const { logger, events } = recordingLogger();
    const hook = createAuditLoggerHook({
      identity: identityWith({ issues: ['PROJ-167'] }),
      auditLogger: logger,
      projectId: 'proj-1',
      now: () => NOW,
    });

    await hook(postToolUseInput('Read', {}), 'tool-use-1', HOOK_OPTIONS);

    expect(events[0].issueRef).toBe('PROJ-167');
    expect(events[1].issueRef).toBe('PROJ-167');
  });

  it('generates a distinct id for each emitted event', async () => {
    const { logger, events } = recordingLogger();
    let counter = 0;
    const hook = createAuditLoggerHook({
      identity: identityWith(),
      auditLogger: logger,
      projectId: 'proj-1',
      now: () => NOW,
      generateEventId: () => `evt-${counter++}`,
    });

    await hook(postToolUseInput('Read', {}), 'tool-use-1', HOOK_OPTIONS);

    expect(events[0].id).toBe('evt-0');
    expect(events[1].id).toBe('evt-1');
  });

  it('ignores hook events other than PostToolUse / PostToolUseFailure', async () => {
    const { logger, events } = recordingLogger();
    const hook = createAuditLoggerHook({
      identity: identityWith(),
      auditLogger: logger,
      projectId: 'proj-1',
      now: () => NOW,
    });

    const result = await hook(
      {
        hook_event_name: 'PreToolUse' as const,
        session_id: 'session-abc',
        transcript_path: '/tmp/transcript',
        cwd: '/Users/kevin/saor',
        tool_name: 'Write',
        tool_input: {},
        tool_use_id: 'tool-use-1',
      },
      'tool-use-1',
      HOOK_OPTIONS,
    );

    expect(result).toEqual({});
    expect(events).toHaveLength(0);
  });

  it('never throws when the audit logger fails, and reports to stderr', async () => {
    const failing: AuditLogger = {
      log: async (): Promise<void> => {
        throw new Error('store unavailable');
      },
    };
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const hook = createAuditLoggerHook({
      identity: identityWith(),
      auditLogger: failing,
      projectId: 'proj-1',
      now: () => NOW,
    });

    const result = await hook(postToolUseInput('Read', {}), 'tool-use-1', HOOK_OPTIONS);

    expect(result).toEqual({});
    expect(consoleError).toHaveBeenCalledOnce();
    consoleError.mockRestore();
  });
});
