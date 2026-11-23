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
 * Detection uses two kinds of evidence, looked for anywhere in the tool's
 * response or error text so it does not depend on the exact shape of the Bash
 * result:
 *
 *   - **The sandbox's own report** — a `<sandbox_violations>` block the SDK
 *     appends to a command's output. Authoritative when present, but in
 *     practice often absent: a live run with five blocked operations produced
 *     none. The likely reason is timing — on macOS the SDK learns of
 *     violations from the system log, which can lag behind a command that
 *     fails quickly.
 *   - **The operating system's error text** — the message a denied operation
 *     makes the command print: `Operation not permitted` under Seatbelt on
 *     macOS, `Read-only file system` under bubblewrap on Linux. This is what
 *     usually fires. It is an inference: those messages can have other causes,
 *     though for a file operation by a sandboxed command the sandbox is by far
 *     the likeliest. The event says which evidence it rests on
 *     (`details.detection`), and its reason is worded accordingly.
 *
 * Limit: a blocked *read* on Linux can surface as `No such file or directory`
 * or `Permission denied`, which are too common to treat as evidence. Such a
 * block still fails and still shows in the command's `tool.completed` event,
 * but produces no `scope.violation`.
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
 * Messages a command prints when the OS refuses it an operation the sandbox
 * forbids: EPERM under Seatbelt (macOS), EROFS under bubblewrap (Linux).
 */
const DENIAL_MESSAGES: readonly string[] = ['Operation not permitted', 'Read-only file system'];

/** At most this many denial lines are kept on the audit event. */
const MAX_DENIAL_LINES = 10;

/**
 * Why a Bash command is believed to have been blocked by the sandbox.
 *
 *   - `sandbox-report` — the SDK's sandbox reported it; `detail` is its report.
 *   - `error-text` — the command's output shows the OS denying an operation;
 *     `detail` is the lines that say so.
 */
export interface SandboxDenialEvidence {
  readonly kind: 'sandbox-report' | 'error-text';
  readonly detail: string;
}

/**
 * Flatten a tool result of any shape to searchable text: every string found
 * anywhere inside it, one after another. A Bash result may be a plain error
 * string or an object with `stdout` / `stderr` fields; collecting the strings
 * (rather than serializing the object) keeps each output line intact.
 */
function toSearchableText(toolResult: unknown): string {
  if (typeof toolResult === 'string') {
    return toolResult;
  }
  if (Array.isArray(toolResult)) {
    return toolResult.map(toSearchableText).join('\n');
  }
  if (typeof toolResult === 'object' && toolResult !== null) {
    return Object.values(toolResult).map(toSearchableText).join('\n');
  }
  return '';
}

/**
 * Extract the sandbox's own violation report from a tool result, or
 * `undefined` when the result carries none.
 */
export function extractSandboxViolations(toolResult: unknown): string | undefined {
  const text = toSearchableText(toolResult);
  const start = text.indexOf(VIOLATIONS_OPEN);
  if (start === -1) {
    return undefined;
  }
  const bodyStart = start + VIOLATIONS_OPEN.length;
  const end = text.indexOf(VIOLATIONS_CLOSE, bodyStart);
  const body = end === -1 ? text.slice(bodyStart) : text.slice(bodyStart, end);
  return body.trim();
}

/**
 * Look for evidence that the sandbox blocked part of a command: the sandbox's
 * own report if there is one, otherwise output lines in which the OS denies an
 * operation. Returns `undefined` when there is neither.
 */
export function detectSandboxDenial(toolResult: unknown): SandboxDenialEvidence | undefined {
  const report = extractSandboxViolations(toolResult);
  if (report !== undefined) {
    return { kind: 'sandbox-report', detail: report };
  }

  const denialLines = toSearchableText(toolResult)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => DENIAL_MESSAGES.some((message) => line.includes(message)));
  if (denialLines.length === 0) {
    return undefined;
  }
  return { kind: 'error-text', detail: denialLines.slice(0, MAX_DENIAL_LINES).join('\n') };
}

/** Inputs for {@link buildSandboxViolationEvent}. */
export interface SandboxViolationEventInput {
  /** The command the agent ran. */
  readonly command: string;
  /** What shows the sandbox blocked something, and on what basis. */
  readonly evidence: SandboxDenialEvidence;
  readonly toolUseId: string;
  readonly sessionId: string;
  readonly eventId: string;
  readonly timestamp: string;
}

/** The event's `reason`, worded to match how sure the evidence is. */
const REASON_BY_EVIDENCE: Readonly<Record<SandboxDenialEvidence['kind'], string>> = {
  'sandbox-report': 'Blocked by the OS sandbox: outside the agent scope',
  'error-text':
    'The operating system denied an operation in this command; the sandbox is the likely cause',
};

/**
 * Build the `scope.violation` event for a sandbox-blocked Bash operation. Pure;
 * `details.toolUseId` ties it to the command's `tool.invoked` /
 * `tool.completed` pair, and `details.detection` records what the event rests
 * on.
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
      detection: input.evidence.kind,
      violations: input.evidence.detail,
      toolUseId: input.toolUseId,
    },
    sessionId: input.sessionId,
    result: 'blocked',
    reason: REASON_BY_EVIDENCE[input.evidence.kind],
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
    const evidence = detectSandboxDenial(toolResult);
    if (evidence === undefined) {
      return {};
    }

    const event = buildSandboxViolationEvent(
      {
        command: commandOf(toolCall.tool_input),
        evidence,
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
