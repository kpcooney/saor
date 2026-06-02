/**
 * agents/src/hooks/scope-enforcement.ts
 *
 * PreToolUse hook that enforces agent scope before every tool invocation.
 * If an agent attempts to write a file outside its allowed glob patterns,
 * invoke a tool not on its allowlist, or act after its credential has expired,
 * this hook blocks the action and logs a security event to the audit trail.
 *
 * The module is split into two layers:
 *
 *   - `evaluateToolCall` — pure scope logic with no SDK dependency. Given an
 *     identity and a tool call, it returns an allow/block decision plus, on a
 *     block, a structured violation. This is the unit-tested core.
 *   - `createScopeEnforcementHook` — the adapter that wraps `evaluateToolCall`
 *     in the SDK's PreToolUse hook signature, builds the audit event on a
 *     block, writes it through the injected AuditLogger, and maps the decision
 *     to the SDK's permission-decision output.
 *
 * Blocking is the default — the check order follows the architecture (file
 * scope, then tool allowlist, then expiry), and any of the three failing
 * denies the tool call.
 *
 * See docs/architecture/sdlc-agent-architecture-research-v4.md Section 7.4
 * for the scope enforcement logic and hook registration pattern.
 */

import { posix as posixPath } from 'node:path';
import { randomUUID } from 'node:crypto';

import type {
  HookInput,
  HookJSONOutput,
  PreToolUseHookInput,
} from '@anthropic-ai/claude-agent-sdk';

import type { AgentIdentity } from '../identity/types.js';
import type { AuditEvent, AuditEventType, AuditLogger } from './audit-logger.js';

/** Tools whose file target is checked against the agent's file-scope globs. */
const FILE_MUTATING_TOOLS: readonly string[] = ['Write', 'Edit'];

/**
 * A scope-enforcement denial. The `eventType` is one of the three security
 * audit events; `action` is a human-readable summary and `reason` explains the
 * denial. `details` carries the structured context (tool, path, the relevant
 * allowlist) for the audit viewer.
 */
export interface ScopeViolation {
  readonly eventType: Extract<
    AuditEventType,
    'scope.violation' | 'tool.blocked' | 'credential.expired'
  >;
  readonly action: string;
  readonly reason: string;
  readonly details: Record<string, unknown>;
}

/**
 * The result of evaluating a tool call against an agent's scope. On `block`,
 * `violation` describes what to audit and why the call was denied.
 */
export type ScopeDecision =
  | { readonly action: 'allow' }
  | { readonly action: 'block'; readonly violation: ScopeViolation };

/** Input to the pure scope evaluator. */
export interface ScopeEvaluationInput {
  readonly identity: AgentIdentity;
  readonly toolName: string;
  /** The raw tool input; only `file_path` is inspected, for file-mutating tools. */
  readonly toolInput: unknown;
  /** Current time, for the expiry check. Defaults to `new Date()`. */
  readonly now?: Date;
  /**
   * Project root used to resolve absolute file paths to project-relative ones
   * before glob matching. When omitted, absolute paths are treated as outside
   * scope (fail closed).
   */
  readonly cwd?: string;
}

const ALLOW: ScopeDecision = { action: 'allow' };

/**
 * Evaluate a single tool call against an agent's scope. Pure logic, no SDK or
 * audit dependency — returns an allow/block decision the caller acts on.
 *
 * Check order matches the architecture (Section 7.4): file scope for
 * file-mutating tools, then the tool allowlist, then credential expiry.
 */
export function evaluateToolCall(input: ScopeEvaluationInput): ScopeDecision {
  const { identity, toolName, toolInput } = input;

  if (FILE_MUTATING_TOOLS.includes(toolName)) {
    const fileDecision = evaluateFileScope(identity, toolName, toolInput, input.cwd);
    if (fileDecision.action === 'block') {
      return fileDecision;
    }
  }

  if (!identity.scope.tools.includes(toolName)) {
    return {
      action: 'block',
      violation: {
        eventType: 'tool.blocked',
        action: `Attempted use of ${toolName}`,
        reason: 'Tool not in agent scope',
        details: { tool: toolName, allowedTools: [...identity.scope.tools] },
      },
    };
  }

  const now = input.now ?? new Date();
  if (isCredentialExpired(identity.expiresAt, now)) {
    return {
      action: 'block',
      violation: {
        eventType: 'credential.expired',
        action: toolName,
        reason: 'Agent credential expired',
        details: {
          tool: toolName,
          expiresAt: identity.expiresAt,
          now: now.toISOString(),
        },
      },
    };
  }

  return ALLOW;
}

function evaluateFileScope(
  identity: AgentIdentity,
  toolName: string,
  toolInput: unknown,
  cwd: string | undefined,
): ScopeDecision {
  const rawPath = extractFilePath(toolInput);
  if (rawPath === undefined) {
    // A file-mutating tool with no resolvable file_path cannot be checked, so
    // it is denied rather than allowed through unchecked.
    return {
      action: 'block',
      violation: {
        eventType: 'scope.violation',
        action: `Attempted ${toolName} with no file path`,
        reason: 'File-mutating tool call is missing a file_path',
        details: { tool: toolName },
      },
    };
  }

  if (!fileIsInScope(rawPath, identity.scope.files, cwd)) {
    return {
      action: 'block',
      violation: {
        eventType: 'scope.violation',
        action: `Attempted write to ${rawPath}`,
        reason: 'File not in agent scope',
        details: {
          tool: toolName,
          filePath: rawPath,
          allowedFiles: [...identity.scope.files],
        },
      },
    };
  }

  return ALLOW;
}

/** Read `file_path` from an arbitrary tool input, if present and a string. */
export function extractFilePath(toolInput: unknown): string | undefined {
  if (typeof toolInput !== 'object' || toolInput === null) {
    return undefined;
  }
  const filePath = (toolInput as Record<string, unknown>)['file_path'];
  return typeof filePath === 'string' && filePath.length > 0 ? filePath : undefined;
}

/** True when `expiresAt` (ISO 8601) is at or before `now`. */
export function isCredentialExpired(expiresAt: string, now: Date): boolean {
  return now.getTime() >= new Date(expiresAt).getTime();
}

/**
 * True when `filePath` matches at least one of the agent's file-scope globs.
 *
 * The path is first normalized to a project-relative POSIX path: backslashes
 * are converted, absolute paths under `cwd` are made relative, and `.`/`..`
 * segments are collapsed. A path that escapes the project root (a leading
 * `..`, or an absolute path outside `cwd`) matches nothing and is therefore
 * out of scope — this is what closes the `src/../etc/passwd` traversal hole.
 */
export function fileIsInScope(
  filePath: string,
  globs: readonly string[],
  cwd?: string,
): boolean {
  const relativePath = toProjectRelativePath(filePath, cwd);
  if (relativePath === undefined) {
    return false;
  }
  return globs.some((glob) => matchesGlob(relativePath, glob));
}

/**
 * Resolve a tool-supplied file path to a normalized project-relative POSIX
 * path, or `undefined` if it cannot be expressed as one (it escapes the
 * project root or is absolute outside `cwd`).
 */
function toProjectRelativePath(filePath: string, cwd?: string): string | undefined {
  const forwardSlashed = filePath.replace(/\\/g, '/');

  let candidate = forwardSlashed;
  if (posixPath.isAbsolute(forwardSlashed)) {
    if (cwd === undefined) {
      return undefined;
    }
    const forwardCwd = cwd.replace(/\\/g, '/');
    const relative = posixPath.relative(forwardCwd, forwardSlashed);
    candidate = relative;
  }

  const normalized = posixPath.normalize(candidate);
  if (normalized === '..' || normalized.startsWith('../') || posixPath.isAbsolute(normalized)) {
    return undefined;
  }
  return normalized.replace(/^\.\//, '');
}

/**
 * Match a normalized POSIX path against a single glob pattern.
 *
 * Supported subset: `**` matches across path separators (any number of
 * segments), `*` matches within a single segment, `?` matches a single
 * non-separator character, and all other characters are literal. This covers
 * the patterns the scope model uses (`src/**`, `agents/src/**\/*.ts`,
 * `docs/*.md`). For a fuller glob grammar later, `picomatch` is already in the
 * dependency tree.
 */
export function matchesGlob(path: string, glob: string): boolean {
  return globToRegExp(glob).test(path);
}

function globToRegExp(glob: string): RegExp {
  const normalizedGlob = glob.replace(/\\/g, '/');
  let pattern = '';
  let index = 0;

  while (index < normalizedGlob.length) {
    const char = normalizedGlob[index];

    if (char === '*') {
      const isDoubleStar = normalizedGlob[index + 1] === '*';
      if (isDoubleStar) {
        pattern += '.*';
        index += 2;
        // Consume a trailing slash so "**/" can also match zero directories.
        if (normalizedGlob[index] === '/') {
          index += 1;
        }
      } else {
        pattern += '[^/]*';
        index += 1;
      }
      continue;
    }

    if (char === '?') {
      pattern += '[^/]';
      index += 1;
      continue;
    }

    pattern += escapeRegExpChar(char as string);
    index += 1;
  }

  return new RegExp(`^${pattern}$`);
}

function escapeRegExpChar(char: string): string {
  return char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

/**
 * Configuration for {@link createScopeEnforcementHook}. The identity and audit
 * logger are required; the rest are injectable for deterministic tests.
 */
export interface ScopeEnforcementConfig {
  /** The identity whose scope is enforced. */
  readonly identity: AgentIdentity;
  /** Where blocked-action audit events are written. */
  readonly auditLogger: AuditLogger;
  /** Project id stamped onto emitted audit events. */
  readonly projectId: string;
  /** Clock for the expiry check and event timestamps. Defaults to the system clock. */
  readonly now?: () => Date;
  /** Audit event id generator. Defaults to a random UUID. */
  readonly generateEventId?: () => string;
}

/**
 * The SDK PreToolUse hook callback signature, expressed in terms of the
 * exported SDK types. Aliased here because the SDK does not re-export its
 * internal `HookCallback` name.
 */
export type PreToolUseHookCallback = (
  input: HookInput,
  toolUseId: string | undefined,
  options: { signal: AbortSignal },
) => Promise<HookJSONOutput>;

/**
 * Build the PreToolUse hook that enforces the given agent's scope. The
 * returned callback is registered with the SDK against the "*" matcher (all
 * tools). On a violation it writes a security audit event and denies the call;
 * otherwise it allows it.
 */
export function createScopeEnforcementHook(
  config: ScopeEnforcementConfig,
): PreToolUseHookCallback {
  const now = config.now ?? (() => new Date());
  const generateEventId = config.generateEventId ?? (() => randomUUID());

  return async function enforceScope(input: HookInput): Promise<HookJSONOutput> {
    if (input.hook_event_name !== 'PreToolUse') {
      // The hook is registered for PreToolUse; ignore anything else.
      return {};
    }
    const preToolUse = input as PreToolUseHookInput;

    const decision = evaluateToolCall({
      identity: config.identity,
      toolName: preToolUse.tool_name,
      toolInput: preToolUse.tool_input,
      now: now(),
      cwd: preToolUse.cwd,
    });

    if (decision.action === 'allow') {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
        },
      };
    }

    const event = buildScopeViolationEvent({
      violation: decision.violation,
      identity: config.identity,
      projectId: config.projectId,
      sessionId: preToolUse.session_id,
      id: generateEventId(),
      timestamp: now().toISOString(),
    });
    await config.auditLogger.log(event);

    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: decision.violation.reason,
      },
    };
  };
}

/** Inputs needed to turn a {@link ScopeViolation} into a full {@link AuditEvent}. */
export interface BuildScopeViolationEventInput {
  readonly violation: ScopeViolation;
  readonly identity: AgentIdentity;
  readonly projectId: string;
  readonly sessionId: string;
  readonly id: string;
  readonly timestamp: string;
}

/**
 * Construct the audit event recorded when scope enforcement blocks a tool
 * call. Pure: the caller supplies the id and timestamp so the event is fully
 * deterministic and testable. The result is always `result: 'blocked'`.
 */
export function buildScopeViolationEvent(
  input: BuildScopeViolationEventInput,
): AuditEvent {
  const { violation, identity } = input;
  return {
    id: input.id,
    timestamp: input.timestamp,
    projectId: input.projectId,
    agentId: identity.id,
    agentRole: identity.role,
    delegationChain: identity.delegationChain,
    eventType: violation.eventType,
    action: violation.action,
    details: violation.details,
    sessionId: input.sessionId,
    result: 'blocked',
    reason: violation.reason,
  };
}
