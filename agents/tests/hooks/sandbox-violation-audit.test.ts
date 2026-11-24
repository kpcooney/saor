/**
 * agents/tests/hooks/sandbox-violation-audit.test.ts
 *
 * Tests for the hook that turns a sandbox-blocked Bash operation into a
 * `scope.violation` audit event (issue #56). The tool results here are
 * fabricated in the two forms the hook recognizes: the SDK's
 * `<sandbox_violations>` report, and the plain OS error text a denied command
 * prints. The error-text form mirrors what a live run produced — the SDK's
 * failure text is `Exit code N`, then the command's output — and is the form
 * that fires in practice; the live check (agents/src/verify-bash-sandbox.ts)
 * confirms it against a real session.
 */

import type { HookInput } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import type { AuditEvent, AuditLogger } from '../../src/hooks/audit-logger.js';
import {
  createSandboxViolationAuditHook,
  detectSandboxDenial,
  extractSandboxViolations,
} from '../../src/hooks/sandbox-violation-audit.js';
import { createAgentIdentity } from '../../src/identity/factory.js';

const NOW = new Date('2026-11-23T12:00:00.000Z');
const HOOK_OPTIONS = { signal: new AbortController().signal };
const VIOLATION_TEXT =
  'bash: docs/notes.md: Operation not permitted\n<sandbox_violations>\nSandbox: bash(123) deny(1) file-write-create /workspace/saor/docs/notes.md\n</sandbox_violations>';

/** What the SDK hands the failure hook when the sandbox denies a write on macOS. */
const MACOS_DENIAL_ERROR = 'Exit code 1\n/bin/sh: docs/existing.md: Operation not permitted';
/** The same on Linux, where bubblewrap mounts the path read-only. */
const LINUX_DENIAL_ERROR =
  'Exit code 1\n/bin/sh: 1: cannot create docs/existing.md: Read-only file system';

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

describe('detectSandboxDenial', () => {
  it('prefers the sandbox report when the result carries one', () => {
    expect(detectSandboxDenial(VIOLATION_TEXT)).toEqual({
      kind: 'sandbox-report',
      detail: 'Sandbox: bash(123) deny(1) file-write-create /workspace/saor/docs/notes.md',
    });
  });

  it('falls back to the OS denial message, keeping only the lines that show it', () => {
    expect(detectSandboxDenial(MACOS_DENIAL_ERROR)).toEqual({
      kind: 'error-text',
      detail: '/bin/sh: docs/existing.md: Operation not permitted',
    });
    expect(detectSandboxDenial(LINUX_DENIAL_ERROR)).toEqual({
      kind: 'error-text',
      detail: '/bin/sh: 1: cannot create docs/existing.md: Read-only file system',
    });
  });

  it('finds the denial inside a structured result as well as a string', () => {
    const evidence = detectSandboxDenial({
      stdout: 'building\nrm: docs/a.md: Operation not permitted\nrm: docs/b.md: Operation not permitted',
      stderr: '',
    });

    expect(evidence).toEqual({
      kind: 'error-text',
      detail: 'rm: docs/a.md: Operation not permitted\nrm: docs/b.md: Operation not permitted',
    });
  });

  it('caps how many denial lines it keeps', () => {
    const many = Array.from({ length: 25 }, (_, i) => `rm: f${i}: Operation not permitted`);

    const evidence = detectSandboxDenial(many.join('\n'));

    expect(evidence?.detail.split('\n')).toHaveLength(10);
  });

  it('sees no denial in an ordinary failure or a clean result', () => {
    for (const result of [
      'Exit code 1\ncat: missing.txt: No such file or directory',
      'Exit code 126\n/bin/sh: ./script.sh: Permission denied',
      'Exit code 1\n2 tests failed',
      { stdout: 'ok', stderr: '' },
      undefined,
    ]) {
      expect(detectSandboxDenial(result)).toBeUndefined();
    }
  });
});

describe('detectSandboxDenial — messages seen in a live run', () => {
  // Error text recorded from a real agent session on macOS with zsh.
  it('recognizes zsh reporting a denied redirection in lowercase', () => {
    expect(
      detectSandboxDenial('Exit code 1\n(eval):1: operation not permitted: docs/existing.md'),
    ).toEqual({
      kind: 'error-text',
      detail: '(eval):1: operation not permitted: docs/existing.md',
    });
  });

  it('recognizes git being refused a branch switch', () => {
    expect(
      detectSandboxDenial("Exit code 128\nerror: couldn't set 'HEAD'\nfatal: unable to update HEAD"),
    ).toEqual({ kind: 'error-text', detail: "error: couldn't set 'HEAD'" });
  });

  it('recognizes cat being refused a protected file', () => {
    expect(
      detectSandboxDenial('Exit code 1\ncat: .sdlc/secret.txt: Operation not permitted'),
    ).toEqual({ kind: 'error-text', detail: 'cat: .sdlc/secret.txt: Operation not permitted' });
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
      reason: 'Blocked by the OS sandbox: outside the agent scope',
      details: {
        tool: 'Bash',
        command: 'echo x > docs/notes.md',
        toolUseId: 'tu-1',
        detection: 'sandbox-report',
        violations: expect.stringContaining('file-write-create'),
      },
    });
  });

  it('records a scope.violation from the OS denial message alone, and says so', async () => {
    // The case that fires in practice: a failed command, no sandbox report.
    const { hook, events } = setup();

    await hook(
      hookInput({ hook_event_name: 'PostToolUseFailure', error: MACOS_DENIAL_ERROR }),
      'tu-1',
      HOOK_OPTIONS,
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: 'scope.violation',
      result: 'blocked',
      reason:
        'The operating system denied an operation in this command; the sandbox is the likely cause',
      details: {
        tool: 'Bash',
        toolUseId: 'tu-1',
        detection: 'error-text',
        violations: '/bin/sh: docs/existing.md: Operation not permitted',
      },
    });
  });

  it('records nothing for a command that failed for an ordinary reason', async () => {
    const { hook, events } = setup();

    await hook(
      hookInput({
        hook_event_name: 'PostToolUseFailure',
        error: 'Exit code 1\nnpm ERR! Test failed. See above for more details.',
      }),
      'tu-1',
      HOOK_OPTIONS,
    );

    expect(events).toHaveLength(0);
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
