/**
 * agents/tests/hooks/sandbox-violation-audit.test.ts
 *
 * Tests for the hook that turns a sandbox-blocked Bash operation into a
 * `scope.violation` audit event (issue #56). The tool results here are
 * fabricated to carry the SDK's `<sandbox_violations>` marker; that the SDK
 * really emits it is part of the live check (agents/src/verify-bash-sandbox.ts).
 */

import type { HookInput } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import type { AuditEvent, AuditLogger } from '../../src/hooks/audit-logger.js';
import {
  createSandboxViolationAuditHook,
  extractSandboxViolations,
} from '../../src/hooks/sandbox-violation-audit.js';
import { createAgentIdentity } from '../../src/identity/factory.js';

const NOW = new Date('2026-11-23T12:00:00.000Z');
const HOOK_OPTIONS = { signal: new AbortController().signal };
const VIOLATION_TEXT =
  'bash: docs/notes.md: Operation not permitted\n<sandbox_violations>\nSandbox: bash(123) deny(1) file-write-create /workspace/saor/docs/notes.md\n</sandbox_violations>';

const identity = createAgentIdentity(
  {
    id: 'agent:code-agent:session-1',
    type: 'specialist',
    role: 'code-agent',
    delegatedBy: 'human:local',
    purpose: 'test',
    scope: {
      issues: ['56'],
      files: ['src/**'],
      branches: ['main'],
      tools: ['Bash'],
      memoryNamespaces: { read: [], write: [] },
    },
  },
  { now: NOW },
);

function setup(logger?: AuditLogger) {
  const events: AuditEvent[] = [];
  const recording: AuditLogger = { log: async (event) => void events.push(event) };
  const hook = createSandboxViolationAuditHook({
    identity,
    auditLogger: logger ?? recording,
    projectId: 'proj-1',
    now: () => NOW,
    generateEventId: () => 'evt-1',
  });
  return { hook, events };
}

/** A PostToolUse / PostToolUseFailure input; only the fields the hook reads. */
function hookInput(fields: Record<string, unknown>): HookInput {
  return {
    session_id: 'sdk-session-abc',
    tool_use_id: 'tu-1',
    tool_name: 'Bash',
    tool_input: { command: 'echo x > docs/notes.md' },
    ...fields,
  } as unknown as HookInput;
}

describe('extractSandboxViolations', () => {
  it('returns the report from a string or from inside a result object', () => {
    const expected =
      'Sandbox: bash(123) deny(1) file-write-create /workspace/saor/docs/notes.md';
    expect(extractSandboxViolations(VIOLATION_TEXT)).toBe(expected);
    expect(extractSandboxViolations({ stdout: '', stderr: VIOLATION_TEXT })).toBe(expected);
  });

  it('returns undefined when the result carries no violation block', () => {
    expect(extractSandboxViolations({ stdout: 'ok', stderr: '' })).toBeUndefined();
    expect(extractSandboxViolations('Operation not permitted')).toBeUndefined();
    expect(extractSandboxViolations(undefined)).toBeUndefined();
  });
});

describe('createSandboxViolationAuditHook', () => {
  it('records a scope.violation when a Bash result reports a sandbox block', async () => {
    const { hook, events } = setup();

    const result = await hook(
      hookInput({
        hook_event_name: 'PostToolUse',
        tool_response: { stdout: '', stderr: VIOLATION_TEXT },
      }),
      'tu-1',
      HOOK_OPTIONS,
    );

    expect(result).toEqual({});
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: 'evt-1',
      eventType: 'scope.violation',
      result: 'blocked',
      agentId: 'agent:code-agent:session-1',
      issueRef: '56',
      sessionId: 'sdk-session-abc',
      details: {
        tool: 'Bash',
        command: 'echo x > docs/notes.md',
        toolUseId: 'tu-1',
        violations: expect.stringContaining('file-write-create'),
      },
    });
  });

  it('also catches a block reported through a failed tool call', async () => {
    const { hook, events } = setup();

    await hook(
      hookInput({ hook_event_name: 'PostToolUseFailure', error: VIOLATION_TEXT }),
      'tu-1',
      HOOK_OPTIONS,
    );

    expect(events).toHaveLength(1);
  });

  it('records nothing for a clean Bash result, another tool, or another event', async () => {
    const { hook, events } = setup();

    await hook(
      hookInput({ hook_event_name: 'PostToolUse', tool_response: { stdout: 'ok', stderr: '' } }),
      'tu-1',
      HOOK_OPTIONS,
    );
    await hook(
      hookInput({
        hook_event_name: 'PostToolUse',
        tool_name: 'Read',
        tool_response: VIOLATION_TEXT,
      }),
      'tu-1',
      HOOK_OPTIONS,
    );
    await hook(
      hookInput({ hook_event_name: 'PreToolUse', tool_response: VIOLATION_TEXT }),
      'tu-1',
      HOOK_OPTIONS,
    );

    expect(events).toHaveLength(0);
  });

  it('does not throw when the audit logger fails', async () => {
    const { hook } = setup({
      log: async () => {
        throw new Error('audit store unavailable');
      },
    });

    await expect(
      hook(
        hookInput({ hook_event_name: 'PostToolUse', tool_response: VIOLATION_TEXT }),
        'tu-1',
        HOOK_OPTIONS,
      ),
    ).resolves.toEqual({});
  });
});
