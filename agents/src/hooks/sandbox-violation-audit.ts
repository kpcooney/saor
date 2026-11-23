/**
 * agents/src/hooks/sandbox-violation-audit.ts
 *
 * PostToolUse hook that records a `scope.violation` audit event when the OS
 * sandbox blocks something a `Bash` command tried to do (issue #56, ADR-010).
 *
 * The scope-enforcement hook denies an out-of-scope `Write` before it runs and
 * audits the attempt. A `Bash` command is different: it is allowed to run, and
 * the sandbox stops the individual operation — a write outside the agent's
 * scope fails with a permission error. Without this hook that attempt would
 * appear in the audit trail only as a `tool.completed` event for a command
 * that happened to fail. With it, the attempt is recorded as what it is.
 *
 * Detection relies on the marker the SDK's sandbox appends to a command's
 * output when it observed violations: a `<sandbox_violations>` block. The hook
 * looks for that marker anywhere in the tool's response or error text, so it
 * does not depend on the exact shape of the Bash result object.
 *
 * Limit: the SDK reports violations this way on macOS only. On Linux a blocked
 * operation still fails, and still shows in the command's `tool.completed`
 * event, but no `scope.violation` event is produced.
 *
 * Like the other audit hooks this is a side effect, never a gate: it returns an
 * empty result and a failed write is reported to stderr, not thrown.
 */

import { randomUUID } from 'node:crypto';

import type {
  HookInput,
  HookJSONOutput,
  PostToolUseFailureHookInput,
  PostToolUseHookInput,
} from '@anthropic-ai/claude-agent-sdk';

import type { AuditEvent, AuditHookCallback, AuditHookConfig } from './audit-logger.js';
import { resolveIssueRef } from './audit-logger.js';

const BASH_TOOL = 'Bash';
const VIOLATIONS_OPEN = '<sandbox_violations>';
const VIOLATIONS_CLOSE = '</sandbox_violations>';

/**
 * Extract the sandbox's violation report from a tool result, or `undefined`
 * when the result carries none. Accepts the response in any shape: it is
 * serialized and searched for the marker block.
 */
export function extractSandboxViolations(toolResult: unknown): string | undefined {
  const text = typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult ?? '');
  const start = text.indexOf(VIOLATIONS_OPEN);
  if (start === -1) {
    return undefined;
  }
  const bodyStart = start + VIOLATIONS_OPEN.length;
  const end = text.indexOf(VIOLATIONS_CLOSE, bodyStart);
  const body = end === -1 ? text.slice(bodyStart) : text.slice(bodyStart, end);
  // Serializing an object escapes the block's newlines; restore them.
  return body.replace(/\\n/g, '\n').trim();
}

/** Inputs for {@link buildSandboxViolationEvent}. */
export interface SandboxViolationEventInput {
  /** The command the agent ran. */
  readonly command: string;
  /** The sandbox's report of what it blocked. */
  readonly violations: string;
  readonly toolUseId: string;
  readonly sessionId: string;
  readonly eventId: string;
  readonly timestamp: string;
}

/**
 * Build the `scope.violation` event for a sandbox-blocked Bash operation. Pure;
 * `details.toolUseId` ties it to the command's `tool.invoked` /
 * `tool.completed` pair.
 */
export function buildSandboxViolationEvent(
  input: SandboxViolationEventInput,
  config: Pick<AuditHookConfig, 'identity' | 'projectId' | 'issueRef'>,
): AuditEvent {
  const issueRef = resolveIssueRef(config.identity, config.issueRef);
  return {
    id: input.eventId,
    timestamp: input.timestamp,
    projectId: config.projectId,
    agentId: config.identity.id,
    agentRole: config.identity.role,
    delegationChain: config.identity.delegationChain,
    eventType: 'scope.violation',
    action: `${BASH_TOOL} command attempted an operation the sandbox blocked`,
    details: {
      tool: BASH_TOOL,
      command: input.command,
      violations: input.violations,
      toolUseId: input.toolUseId,
    },
    sessionId: input.sessionId,
    result: 'blocked',
    reason: 'Blocked by the OS sandbox: outside the agent scope',
    ...(issueRef !== undefined ? { issueRef } : {}),
  };
}

function commandOf(toolInput: unknown): string {
  if (typeof toolInput === 'object' && toolInput !== null) {
    const command = (toolInput as Record<string, unknown>)['command'];
    if (typeof command === 'string') {
      return command;
    }
  }
  return '';
}

/**
 * Build the **PostToolUse** / **PostToolUseFailure** hook that audits sandbox
 * violations. Register it for both events: a command whose write was blocked
 * may be reported as a success with error output or as a failure.
 */
export function createSandboxViolationAuditHook(config: AuditHookConfig): AuditHookCallback {
  const now = config.now ?? (() => new Date());
  const generateEventId = config.generateEventId ?? (() => randomUUID());

  return async function auditSandboxViolations(input: HookInput): Promise<HookJSONOutput> {
    let toolResult: unknown;
    if (input.hook_event_name === 'PostToolUse') {
      toolResult = (input as PostToolUseHookInput).tool_response;
    } else if (input.hook_event_name === 'PostToolUseFailure') {
      toolResult = (input as PostToolUseFailureHookInput).error;
    } else {
      return {};
    }
    const toolCall = input as PostToolUseHookInput | PostToolUseFailureHookInput;
    if (toolCall.tool_name !== BASH_TOOL) {
      return {};
    }
    const violations = extractSandboxViolations(toolResult);
    if (violations === undefined) {
      return {};
    }

    const event = buildSandboxViolationEvent(
      {
        command: commandOf(toolCall.tool_input),
        violations,
        toolUseId: toolCall.tool_use_id,
        sessionId: toolCall.session_id,
        eventId: generateEventId(),
        timestamp: now().toISOString(),
      },
      config,
    );
    try {
      await config.auditLogger.log(event);
    } catch (error) {
      console.error(
        'sandbox-violation-audit: failed to write a scope.violation event; continuing',
        error,
      );
    }
    return {};
  };
}
