/**
 * Acceptance: issue #10 — the tool audit hooks (PreToolUse `tool.invoked`,
 * PostToolUse / PostToolUseFailure `tool.completed`; see ADR-006).
 *
 * Definition of done: every tool call an agent makes leaves a correlated
 * invoked/completed pair in the audit trail, carrying who did it and for which
 * issue, without the agent opting in — and auditing never changes whether or
 * how the tool runs.
 *
 * Real store: a JSONL audit file in a temp project, read back from disk. The
 * negative controls are a hook event that is not a tool call (nothing may be
 * written) and an audit file that cannot be written (the hook must still
 * return normally), so a hook that logs indiscriminately, or one that gates
 * the tool on the audit write, cannot pass.
 */

import type {
  HookInput,
  PostToolUseFailureHookInput,
  PostToolUseHookInput,
  PreToolUseHookInput,
} from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createToolCompletedAuditHook,
  createToolInvokedAuditHook,
  type AuditHookConfig,
} from '../../src/hooks/audit-logger.js';
import { createAgentIdentity } from '../../src/identity/factory.js';
import { JsonlAuditLogger } from '../support/jsonl-audit-logger.js';
import { createTempProject, type TempProject } from './support/temp-project.js';

const SESSION = 'session-acceptance-10';
const HOOK_OPTIONS = { signal: new AbortController().signal };

const identity = createAgentIdentity({
  id: 'agent:code-agent:acceptance-10',
  type: 'specialist',
  role: 'code-agent',
  delegatedBy: 'human:kevin',
  purpose: 'Implement #10',
  scope: {
    issues: ['10'],
    files: ['src/**'],
    branches: ['10/audit-hook'],
    tools: ['Read', 'Write'],
    memoryNamespaces: { read: [], write: [] },
  },
});

describe('#10 tool audit hooks', () => {
  let project: TempProject;
  let config: AuditHookConfig;

  beforeEach(() => {
    project = createTempProject('10/audit-hook');
    config = { identity, auditLogger: project.auditLogger, projectId: 'proj-acceptance' };
  });

  afterEach(() => {
    project.remove();
  });

  function base(toolUseId: string) {
    return {
      session_id: SESSION,
      transcript_path: project.pathOf('transcript.jsonl'),
      cwd: project.root,
      tool_name: 'Write',
      tool_input: { file_path: project.pathOf('src/a.ts'), content: 'export {};\n' },
      tool_use_id: toolUseId,
    };
  }

  function preToolUse(toolUseId: string): PreToolUseHookInput {
    return { hook_event_name: 'PreToolUse', ...base(toolUseId) };
  }

  function postToolUse(toolUseId: string): PostToolUseHookInput {
    return {
      hook_event_name: 'PostToolUse',
      ...base(toolUseId),
      tool_response: { type: 'create' },
    };
  }

  function postToolUseFailure(toolUseId: string, error: string): PostToolUseFailureHookInput {
    return { hook_event_name: 'PostToolUseFailure', ...base(toolUseId), error };
  }

  it('records a correlated invoked/completed pair for a successful tool call', async () => {
    const invoked = await createToolInvokedAuditHook(config)(
      preToolUse('tu-1'),
      'tu-1',
      HOOK_OPTIONS,
    );
    // After the pre hook alone there is exactly the pending half of the pair.
    expect(project.readAudit().map((e) => [e.eventType, e.result])).toEqual([
      ['tool.invoked', 'pending'],
    ]);

    const completed = await createToolCompletedAuditHook(config)(
      postToolUse('tu-1'),
      'tu-1',
      HOOK_OPTIONS,
    );

    const events = project.readAudit();
    expect(events.map((e) => [e.eventType, e.result])).toEqual([
      ['tool.invoked', 'pending'],
      ['tool.completed', 'success'],
    ]);
    for (const event of events) {
      expect(event).toMatchObject({
        agentId: identity.id,
        agentRole: 'code-agent',
        delegationChain: ['human:kevin', identity.id],
        projectId: 'proj-acceptance',
        sessionId: SESSION,
        issueRef: '10',
        action: 'Write',
      });
      expect(event.details.toolUseId).toBe('tu-1');
    }
    expect(events[0]!.id).not.toBe(events[1]!.id);

    // Auditing expresses no opinion on the call: both hooks return nothing.
    expect(invoked).toEqual({});
    expect(completed).toEqual({});
  });

  it('records a failed tool call as completed with result failure and the error as the reason', async () => {
    await createToolInvokedAuditHook(config)(preToolUse('tu-2'), 'tu-2', HOOK_OPTIONS);
    await createToolCompletedAuditHook(config)(
      postToolUseFailure('tu-2', 'EACCES: permission denied'),
      'tu-2',
      HOOK_OPTIONS,
    );

    const completed = project.readAudit().filter((e) => e.eventType === 'tool.completed');
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({
      result: 'failure',
      reason: 'EACCES: permission denied',
    });
    expect(completed[0]!.details.toolUseId).toBe('tu-2');
  });

  it('keeps two tool calls apart by their tool-use ids', async () => {
    const invokedHook = createToolInvokedAuditHook(config);
    const completedHook = createToolCompletedAuditHook(config);

    await invokedHook(preToolUse('tu-a'), 'tu-a', HOOK_OPTIONS);
    await invokedHook(preToolUse('tu-b'), 'tu-b', HOOK_OPTIONS);
    await completedHook(postToolUseFailure('tu-b', 'boom'), 'tu-b', HOOK_OPTIONS);
    await completedHook(postToolUse('tu-a'), 'tu-a', HOOK_OPTIONS);

    const outcomeOf = (toolUseId: string) =>
      project
        .readAudit()
        .filter((e) => e.details.toolUseId === toolUseId)
        .map((e) => e.result);
    expect(outcomeOf('tu-a')).toEqual(['pending', 'success']);
    expect(outcomeOf('tu-b')).toEqual(['pending', 'failure']);
  });

  it('writes nothing for a hook event that is not a tool call', async () => {
    const notAToolCall = {
      hook_event_name: 'UserPromptSubmit',
      session_id: SESSION,
      transcript_path: project.pathOf('transcript.jsonl'),
      cwd: project.root,
      prompt: 'hello',
    } as HookInput;

    await createToolInvokedAuditHook(config)(notAToolCall, undefined, HOOK_OPTIONS);
    await createToolCompletedAuditHook(config)(notAToolCall, undefined, HOOK_OPTIONS);
    // A pre hook must not complete a call, nor a post hook invoke one.
    await createToolCompletedAuditHook(config)(preToolUse('tu-3'), 'tu-3', HOOK_OPTIONS);
    await createToolInvokedAuditHook(config)(postToolUse('tu-3'), 'tu-3', HOOK_OPTIONS);

    expect(project.readAudit()).toEqual([]);
  });

  it('never gates the tool on the audit write: an unwritable audit file still returns normally', async () => {
    // A real failure, not a mock: the audit file's directory does not exist.
    const unwritable = new JsonlAuditLogger(project.pathOf('missing-dir/audit.jsonl'));
    const broken: AuditHookConfig = { ...config, auditLogger: unwritable };
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await expect(
        createToolInvokedAuditHook(broken)(preToolUse('tu-4'), 'tu-4', HOOK_OPTIONS),
      ).resolves.toEqual({});
      await expect(
        createToolCompletedAuditHook(broken)(postToolUse('tu-4'), 'tu-4', HOOK_OPTIONS),
      ).resolves.toEqual({});
      // The failure is reported, not swallowed silently.
      expect(stderr).toHaveBeenCalledTimes(2);
    } finally {
      stderr.mockRestore();
    }

    // Control: the same calls against the writable file do get recorded.
    await createToolInvokedAuditHook(config)(preToolUse('tu-4'), 'tu-4', HOOK_OPTIONS);
    expect(project.readAudit()).toHaveLength(1);
  });
});
