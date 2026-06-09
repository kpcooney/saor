/**
 * Tests for the audit-logging hooks (issue #10).
 *
 * A tool call is audited as two events emitted by two hooks: `tool.invoked`
 * from a PreToolUse hook (before the tool runs) and `tool.completed` from a
 * PostToolUse / PostToolUseFailure hook (after it returns). The pure event
 * builders and helpers are tested with no SDK dependency. The hook adapters are
 * tested by invoking the returned callbacks with plain hook-input objects and a
 * recording AuditLogger double — no real SDK runtime is involved.
 */

import { describe, expect, it, vi } from 'vitest';

import { createAgentIdentity } from '../../src/identity/factory.js';
import type { AgentIdentity, AgentScope } from '../../src/identity/types.js';
import {
  buildToolCompletedEvent,
  buildToolInvokedEvent,
  createToolCompletedAuditHook,
  createToolInvokedAuditHook,
  detectToolResponseFailure,
  resolveIssueRef,
  type AuditEvent,
  type AuditLogger,
  type ToolEventInput,
} from '../../src/hooks/audit-logger.js';

const NOW = new Date('2026-06-01T12:00:00.000Z');
const FUTURE = new Date('2026-06-01T18:00:00.000Z').toISOString();

// Distinct instants for the invoked (before) and completed (after) events.
const INVOKE_TIME = new Date('2026-06-01T12:00:00.000Z');
const COMPLETE_TIME = new Date('2026-06-01T12:00:00.250Z');

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

/** Build a plain PreToolUse input object. */
function preToolUseInput(toolName: string, toolInput: unknown, toolUseId = 'tool-use-1') {
  return {
    hook_event_name: 'PreToolUse' as const,
    session_id: 'session-abc',
    transcript_path: '/tmp/transcript',
    cwd: '/Users/kevin/saor',
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: toolUseId,
  };
}

/** Build a plain PostToolUse (success) input object. */
function postToolUseInput(
  toolName: string,
  toolInput: unknown,
  toolResponse: unknown = {},
  toolUseId = 'tool-use-1',
) {
  return {
    hook_event_name: 'PostToolUse' as const,
    session_id: 'session-abc',
    transcript_path: '/tmp/transcript',
    cwd: '/Users/kevin/saor',
    tool_name: toolName,
    tool_input: toolInput,
    tool_response: toolResponse,
    tool_use_id: toolUseId,
  };
}

/** Build a plain PostToolUseFailure (error) input object. */
function postToolUseFailureInput(
  toolName: string,
  toolInput: unknown,
  error: string,
  toolUseId = 'tool-use-1',
) {
  return {
    hook_event_name: 'PostToolUseFailure' as const,
    session_id: 'session-abc',
    transcript_path: '/tmp/transcript',
    cwd: '/Users/kevin/saor',
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: toolUseId,
    error,
  };
}

const HOOK_OPTIONS = { signal: new AbortController().signal };

const eventInputBase: ToolEventInput = {
  toolName: 'Write',
  toolInput: { file_path: 'agents/src/new.ts', content: 'x' },
  identity: identityWith(),
  projectId: 'proj-1',
  sessionId: 'session-abc',
  toolUseId: 'tool-use-1',
  eventId: 'evt-1',
  timestamp: NOW.toISOString(),
};

describe('buildToolInvokedEvent', () => {
  it('produces a tool.invoked event with result pending', () => {
    const event = buildToolInvokedEvent(eventInputBase);
    expect(event.eventType).toBe('tool.invoked');
    expect(event.result).toBe('pending');
    expect(event.reason).toBeUndefined();
  });

  it('records the tool name as the action and the parameters and toolUseId in details', () => {
    const event = buildToolInvokedEvent(eventInputBase);
    expect(event.action).toBe('Write');
    expect(event.details).toEqual({
      tool: 'Write',
      parameters: { file_path: 'agents/src/new.ts', content: 'x' },
      toolUseId: 'tool-use-1',
    });
  });

  it('carries identity, project, session, id, and timestamp', () => {
    const identity = identityWith();
    const event = buildToolInvokedEvent({ ...eventInputBase, identity });
    expect(event.agentId).toBe(identity.id);
    expect(event.agentRole).toBe('code-agent');
    expect(event.delegationChain).toEqual(identity.delegationChain);
    expect(event.projectId).toBe('proj-1');
    expect(event.sessionId).toBe('session-abc');
    expect(event.id).toBe('evt-1');
    expect(event.timestamp).toBe(NOW.toISOString());
  });

  it('stamps issueRef when supplied and omits it otherwise', () => {
    expect(buildToolInvokedEvent({ ...eventInputBase, issueRef: 'PROJ-167' }).issueRef).toBe(
      'PROJ-167',
    );
    expect('issueRef' in buildToolInvokedEvent(eventInputBase)).toBe(false);
  });

  it('wraps non-object tool input under a value key', () => {
    const event = buildToolInvokedEvent({ ...eventInputBase, toolName: 'Bash', toolInput: 'ls -la' });
    expect(event.details).toEqual({
      tool: 'Bash',
      parameters: { value: 'ls -la' },
      toolUseId: 'tool-use-1',
    });
  });
});

describe('buildToolCompletedEvent', () => {
  it('produces a tool.completed event with result success and no reason', () => {
    const event = buildToolCompletedEvent({
      ...eventInputBase,
      eventId: 'evt-2',
      outcome: { result: 'success', response: { ok: true } },
    });
    expect(event.eventType).toBe('tool.completed');
    expect(event.result).toBe('success');
    expect(event.reason).toBeUndefined();
    expect(event.id).toBe('evt-2');
  });

  it('puts the error reason on a failed completed event', () => {
    const event = buildToolCompletedEvent({
      ...eventInputBase,
      outcome: { result: 'failure', reason: 'disk full' },
    });
    expect(event.result).toBe('failure');
    expect(event.reason).toBe('disk full');
  });

  it('shares the correlation toolUseId with the matching invoked event', () => {
    const invoked = buildToolInvokedEvent(eventInputBase);
    const completed = buildToolCompletedEvent({
      ...eventInputBase,
      eventId: 'evt-2',
      outcome: { result: 'success', response: {} },
    });
    expect(completed.details.toolUseId).toBe(invoked.details.toolUseId);
    expect(completed.details.toolUseId).toBe('tool-use-1');
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

  it('extracts the message from error, then message', () => {
    expect(detectToolResponseFailure({ is_error: true, error: 'boom' })).toBe('boom');
    expect(detectToolResponseFailure({ isError: true, message: 'nope' })).toBe('nope');
  });

  it('prefers error over message when both are present', () => {
    expect(detectToolResponseFailure({ is_error: true, error: 'a', message: 'b' })).toBe('a');
  });

  it('ignores content as an error reason and falls back to the generic message', () => {
    // `content` is the successful-payload field, not an error string.
    expect(detectToolResponseFailure({ is_error: true, content: 'the result' })).toBe(
      'Tool reported an error',
    );
    expect(detectToolResponseFailure({ isError: true, content: ['block'] })).toBe(
      'Tool reported an error',
    );
  });

  it('falls back to a generic message when the error flag carries no usable text', () => {
    expect(detectToolResponseFailure({ is_error: true })).toBe('Tool reported an error');
    expect(detectToolResponseFailure({ is_error: true, error: 42 })).toBe('Tool reported an error');
  });
});

describe('createToolInvokedAuditHook', () => {
  it('writes a single tool.invoked event and expresses no permission opinion', async () => {
    const { logger, events } = recordingLogger();
    const hook = createToolInvokedAuditHook({
      identity: identityWith(),
      auditLogger: logger,
      projectId: 'proj-1',
      now: () => INVOKE_TIME,
    });

    const result = await hook(
      preToolUseInput('Write', { file_path: 'agents/src/new.ts' }),
      'tool-use-1',
      HOOK_OPTIONS,
    );

    // Empty result = no permission decision; auditing must not gate the call.
    expect(result).toEqual({});
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('tool.invoked');
    expect(events[0].result).toBe('pending');
    expect(events[0].details.toolUseId).toBe('tool-use-1');
    expect(events[0].timestamp).toBe(INVOKE_TIME.toISOString());
  });

  it('ignores hook events other than PreToolUse', async () => {
    const { logger, events } = recordingLogger();
    const hook = createToolInvokedAuditHook({
      identity: identityWith(),
      auditLogger: logger,
      projectId: 'proj-1',
      now: () => INVOKE_TIME,
    });

    const result = await hook(
      postToolUseInput('Write', {}) as never,
      'tool-use-1',
      HOOK_OPTIONS,
    );

    expect(result).toEqual({});
    expect(events).toHaveLength(0);
  });
});

describe('createToolCompletedAuditHook', () => {
  it('emits a correctly-structured tool.completed event with result success', async () => {
    const { logger, events } = recordingLogger();
    const hook = createToolCompletedAuditHook({
      identity: identityWith(),
      auditLogger: logger,
      projectId: 'proj-1',
      now: () => COMPLETE_TIME,
    });

    const result = await hook(
      postToolUseInput('Write', { file_path: 'agents/src/new.ts' }),
      'tool-use-1',
      HOOK_OPTIONS,
    );

    expect(result).toEqual({});
    expect(events).toHaveLength(1);
    const completed = events[0];
    expect(completed.eventType).toBe('tool.completed');
    expect(completed.result).toBe('success');
    expect(completed.action).toBe('Write');
    expect(completed.details).toEqual({
      tool: 'Write',
      parameters: { file_path: 'agents/src/new.ts' },
      toolUseId: 'tool-use-1',
    });
    expect(completed.sessionId).toBe('session-abc');
  });

  it('emits result failure with the error reason on PostToolUseFailure', async () => {
    const { logger, events } = recordingLogger();
    const hook = createToolCompletedAuditHook({
      identity: identityWith(),
      auditLogger: logger,
      projectId: 'proj-1',
      now: () => COMPLETE_TIME,
    });

    await hook(
      postToolUseFailureInput('Write', { file_path: 'agents/src/new.ts' }, 'permission denied'),
      'tool-use-1',
      HOOK_OPTIONS,
    );

    expect(events).toHaveLength(1);
    expect(events[0].result).toBe('failure');
    expect(events[0].reason).toBe('permission denied');
  });

  it('treats an in-band error response on PostToolUse as a failure', async () => {
    const { logger, events } = recordingLogger();
    const hook = createToolCompletedAuditHook({
      identity: identityWith(),
      auditLogger: logger,
      projectId: 'proj-1',
      now: () => COMPLETE_TIME,
    });

    await hook(
      postToolUseInput('Read', { file_path: 'agents/src/a.ts' }, { is_error: true, error: 'nope' }),
      'tool-use-1',
      HOOK_OPTIONS,
    );

    expect(events[0].result).toBe('failure');
    expect(events[0].reason).toBe('nope');
  });

  it('sets delegationChain to match the agent identity used', async () => {
    const { logger, events } = recordingLogger();
    const identity = identityWith();
    const hook = createToolCompletedAuditHook({
      identity,
      auditLogger: logger,
      projectId: 'proj-1',
      now: () => COMPLETE_TIME,
    });

    await hook(postToolUseInput('Read', {}), 'tool-use-1', HOOK_OPTIONS);

    expect(events[0].delegationChain).toEqual(identity.delegationChain);
    expect(events[0].agentId).toBe(identity.id);
  });

  it('ignores hook events other than PostToolUse / PostToolUseFailure', async () => {
    const { logger, events } = recordingLogger();
    const hook = createToolCompletedAuditHook({
      identity: identityWith(),
      auditLogger: logger,
      projectId: 'proj-1',
      now: () => COMPLETE_TIME,
    });

    const result = await hook(preToolUseInput('Write', {}) as never, 'tool-use-1', HOOK_OPTIONS);

    expect(result).toEqual({});
    expect(events).toHaveLength(0);
  });

  it('uses the default clock and id generator when none are injected', async () => {
    const { logger, events } = recordingLogger();
    const hook = createToolCompletedAuditHook({
      identity: identityWith(),
      auditLogger: logger,
      projectId: 'proj-1',
    });

    await hook(postToolUseInput('Read', {}), 'tool-use-1', HOOK_OPTIONS);

    const event = events[0];
    expect(Number.isNaN(Date.parse(event.timestamp))).toBe(false);
    expect(event.timestamp).toBe(new Date(event.timestamp).toISOString());
    expect(event.id).toMatch(/[0-9a-f-]{36}/);
  });
});

describe('the two hooks together', () => {
  it('correlate invoked and completed by toolUseId with distinct, ordered timestamps', async () => {
    const { logger, events } = recordingLogger();
    const identity = identityWith();
    const invokedHook = createToolInvokedAuditHook({
      identity,
      auditLogger: logger,
      projectId: 'proj-1',
      now: () => INVOKE_TIME,
    });
    const completedHook = createToolCompletedAuditHook({
      identity,
      auditLogger: logger,
      projectId: 'proj-1',
      now: () => COMPLETE_TIME,
    });

    await invokedHook(preToolUseInput('Write', { file_path: 'agents/src/x.ts' }, 'tu-42'), 'tu-42', HOOK_OPTIONS);
    await completedHook(
      postToolUseInput('Write', { file_path: 'agents/src/x.ts' }, {}, 'tu-42'),
      'tu-42',
      HOOK_OPTIONS,
    );

    const [invoked, completed] = events;
    expect(invoked.eventType).toBe('tool.invoked');
    expect(completed.eventType).toBe('tool.completed');
    // Correlated by toolUseId...
    expect(invoked.details.toolUseId).toBe('tu-42');
    expect(completed.details.toolUseId).toBe('tu-42');
    // ...and distinct, with invoked strictly before completed.
    expect(invoked.timestamp).not.toBe(completed.timestamp);
    expect(Date.parse(invoked.timestamp)).toBeLessThan(Date.parse(completed.timestamp));
  });
});

describe('audit logging is best-effort and never throws', () => {
  it('the invoked hook swallows a logger failure and reports to stderr', async () => {
    const failing: AuditLogger = {
      log: async (): Promise<void> => {
        throw new Error('store unavailable');
      },
    };
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const hook = createToolInvokedAuditHook({
      identity: identityWith(),
      auditLogger: failing,
      projectId: 'proj-1',
      now: () => INVOKE_TIME,
    });

    const result = await hook(preToolUseInput('Read', {}), 'tool-use-1', HOOK_OPTIONS);

    expect(result).toEqual({});
    expect(consoleError).toHaveBeenCalledOnce();
    consoleError.mockRestore();
  });

  it('the completed hook swallows a logger failure and reports to stderr', async () => {
    const failing: AuditLogger = {
      log: async (): Promise<void> => {
        throw new Error('store unavailable');
      },
    };
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const hook = createToolCompletedAuditHook({
      identity: identityWith(),
      auditLogger: failing,
      projectId: 'proj-1',
      now: () => COMPLETE_TIME,
    });

    const result = await hook(postToolUseInput('Read', {}), 'tool-use-1', HOOK_OPTIONS);

    expect(result).toEqual({});
    expect(consoleError).toHaveBeenCalledOnce();
    consoleError.mockRestore();
  });
});
