/**
 * agents/src/hooks/scope-enforcement.ts
 *
 * PreToolUse hook that enforces agent scope before every tool invocation.
 * If an agent attempts to write a file outside its allowed glob patterns, read
 * outside its read scope, invoke a tool not on its allowlist, run `Bash`
 * without an OS sandbox, or act after its credential has expired, this hook
 * blocks the action and logs a security event to the audit trail.
 *
 * What this hook confines, and what it leaves to another layer:
 *
 *   - `Write` / `Edit` / `MultiEdit` / `NotebookEdit` — the target file must
 *     match the agent's file-scope globs. Enforced here.
 *   - `Read` / `Grep` / `Glob` — the target must be inside the project root and
 *     must not be a protected path (see ../sandbox/protected-paths.ts).
 *     Enforced here, for the target each call names. A `Grep` or `Glob` over a
 *     directory is checked by that directory, not by every file beneath it;
 *     the SDK's `Read(...)` deny rules registered alongside this hook (see
 *     ../definitions/code-agent.ts) are what keep protected files out of such
 *     a search.
 *   - `Bash` — NOT path-checked here. A shell command can read or write files
 *     in more ways than a parser can catch, so Bash is confined by the OS
 *     sandbox configured in ../sandbox/bash-sandbox.ts. This hook's part is to
 *     refuse Bash entirely unless the caller attests that sandbox is in place.
 *
 * `scope.branches` is not enforced by this hook.
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
 * scope, then tool allowlist, then expiry), with the read-scope check alongside
 * file scope and the Bash sandbox check alongside the allowlist. Any check
 * failing denies the tool call.
 *
 * See docs/architecture/sdlc-agent-architecture-research-v4.md Section 7.4
 * for the scope enforcement logic and hook registration pattern, and
 * docs/adr/010-bash-and-read-confinement.md for the read and Bash decisions.
 */

import { posix as posixPath } from 'node:path';
import { randomUUID } from 'node:crypto';

import type {
  HookInput,
  HookJSONOutput,
  PreToolUseHookInput,
} from '@anthropic-ai/claude-agent-sdk';

import type { AgentIdentity } from '../identity/types.js';
import { PROTECTED_PROJECT_GLOBS } from '../sandbox/protected-paths.js';
import type { AuditEvent, AuditEventType, AuditLogger } from './audit-logger.js';

/**
 * Tools whose file target is checked against the agent's file-scope globs.
 *
 * The architecture (Section 7.4) illustrates this with `["Write", "Edit"]`, but
 * enforcement must cover *every* tool that writes a file — otherwise an agent
 * granted a sibling editing tool could write outside its file scope unchecked.
 * This list must track the SDK's file-mutating tool surface; when a new file
 * writer is added to the harness, add it here (and teach `extractFilePath` its
 * path-parameter name if it differs from `file_path`).
 */
const FILE_MUTATING_TOOLS: readonly string[] = [
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
];

/**
 * Tools whose read target is checked against the agent's read scope: it must
 * be inside the project root and must not be a protected path. When a new
 * file-reading tool is granted to an agent, add it here and teach
 * `extractReadTargets` where its target lives.
 */
const PATH_READING_TOOLS: readonly string[] = ['Read', 'Grep', 'Glob'];

/** The shell tool, which is confined by the OS sandbox rather than this hook. */
const BASH_TOOL = 'Bash';

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
  /**
   * The raw tool input. Only the path parameters are inspected: the write
   * target of file-mutating tools and the read target of file-reading tools.
   */
  readonly toolInput: unknown;
  /** Current time, for the expiry check. Defaults to `new Date()`. */
  readonly now?: Date;
  /**
   * Project root used to resolve absolute file paths to project-relative ones
   * before glob matching. When omitted, absolute paths are treated as outside
   * scope (fail closed).
   */
  readonly cwd?: string;
  /**
   * Whether `Bash` commands run inside the OS sandbox. Only `true` lets a Bash
   * call through; when omitted or `false`, Bash is denied even if it is on the
   * agent's tool allowlist, because nothing else confines what it writes.
   */
  readonly isBashSandboxed?: boolean;
}

const ALLOW: ScopeDecision = { action: 'allow' };

/**
 * Evaluate a single tool call against an agent's scope. Pure logic, no SDK or
 * audit dependency — returns an allow/block decision the caller acts on.
 *
 * Check order matches the architecture (Section 7.4): file scope for
 * file-mutating tools (and read scope for file-reading tools), then the tool
 * allowlist (and the Bash sandbox requirement), then credential expiry.
 */
export function evaluateToolCall(input: ScopeEvaluationInput): ScopeDecision {
  const { identity, toolName, toolInput } = input;

  if (FILE_MUTATING_TOOLS.includes(toolName)) {
    const fileDecision = evaluateFileScope(identity, toolName, toolInput, input.cwd);
    if (fileDecision.action === 'block') {
      return fileDecision;
    }
  }

  if (PATH_READING_TOOLS.includes(toolName)) {
    const readDecision = evaluateReadScope(toolName, toolInput, input.cwd);
    if (readDecision.action === 'block') {
      return readDecision;
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

  if (toolName === BASH_TOOL && input.isBashSandboxed !== true) {
    return {
      action: 'block',
      violation: {
        eventType: 'tool.blocked',
        action: `Attempted use of ${toolName}`,
        reason: 'Bash is only permitted inside the OS sandbox, which is not active',
        details: { tool: toolName },
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
        action: `Attempted ${toolName} to ${rawPath}`,
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

/**
 * Check a file-reading tool call against the read scope: every target the call
 * names must resolve inside the project root, and none may be a protected
 * path. A `Read` with no resolvable `file_path` is denied (fail closed).
 */
function evaluateReadScope(
  toolName: string,
  toolInput: unknown,
  cwd: string | undefined,
): ScopeDecision {
  const targets = extractReadTargets(toolName, toolInput);
  if (targets === undefined) {
    return {
      action: 'block',
      violation: {
        eventType: 'scope.violation',
        action: `Attempted ${toolName} with no file path`,
        reason: 'File-reading tool call is missing its target path',
        details: { tool: toolName },
      },
    };
  }

  for (const target of targets) {
    const relativePath = toProjectRelativePath(target, cwd);
    if (relativePath === undefined) {
      return blockedRead(toolName, target, 'Read target is outside the project');
    }
    if (isProtectedPath(relativePath)) {
      return blockedRead(toolName, target, 'Read target is a protected path');
    }
  }
  return ALLOW;
}

function blockedRead(toolName: string, target: string, reason: string): ScopeDecision {
  return {
    action: 'block',
    violation: {
      eventType: 'scope.violation',
      action: `Attempted ${toolName} of ${target}`,
      reason,
      details: { tool: toolName, filePath: target },
    },
  };
}

/** True when a project-relative path is one no agent may read. */
export function isProtectedPath(relativePath: string): boolean {
  return PROTECTED_PROJECT_GLOBS.some((glob) => matchesGlob(relativePath, glob));
}

const GLOB_CHARACTERS = /[*?[\]{}]/;

/**
 * The literal directory prefix of a glob pattern: the segments before the
 * first one containing a glob character. `/etc/**` yields `/etc`, `../*.md`
 * yields `..`, and `**\/*.ts` yields `''` (no prefix).
 */
function literalPrefixOfPattern(pattern: string): string {
  const segments = pattern.replace(/\\/g, '/').split('/');
  const firstGlob = segments.findIndex((segment) => GLOB_CHARACTERS.test(segment));
  const literal = firstGlob === -1 ? segments : segments.slice(0, firstGlob);
  return literal.join('/');
}

/**
 * The paths a file-reading tool call will read from, or `undefined` when a
 * required target is missing.
 *
 *   - `Read` reads exactly `file_path` (required).
 *   - `Grep` searches under `path`, defaulting to the project root.
 *   - `Glob` matches `pattern` under `path`, defaulting to the project root.
 *     The pattern can itself point elsewhere (`/etc/**`, `../**`), so its
 *     literal prefix — resolved against `path` — is a target too.
 *
 * An omitted optional `path` contributes `'.'`, the project root.
 */
export function extractReadTargets(toolName: string, toolInput: unknown): string[] | undefined {
  const record =
    typeof toolInput === 'object' && toolInput !== null
      ? (toolInput as Record<string, unknown>)
      : {};
  const stringParam = (name: string): string | undefined => {
    const value = record[name];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  };

  if (toolName === 'Read') {
    const filePath = stringParam('file_path');
    return filePath === undefined ? undefined : [filePath];
  }

  const searchRoot = stringParam('path') ?? '.';
  if (toolName !== 'Glob') {
    return [searchRoot];
  }

  const prefix = literalPrefixOfPattern(stringParam('pattern') ?? '');
  if (prefix === '') {
    // A leading '/' with nothing after it before the first glob (`/*`) still
    // makes the pattern absolute; an empty prefix otherwise adds nothing.
    return (stringParam('pattern') ?? '').startsWith('/') ? [searchRoot, '/'] : [searchRoot];
  }
  const patternTarget = posixPath.isAbsolute(prefix) ? prefix : posixPath.join(searchRoot, prefix);
  return [searchRoot, patternTarget];
}

/**
 * Read the target file path from an arbitrary tool input, if present.
 *
 * File-mutating tools name their path parameter differently: Write/Edit/
 * MultiEdit use `file_path`; NotebookEdit uses `notebook_path`. Only string
 * paths are honored — a missing, non-string, or empty value yields `undefined`,
 * which the caller treats as "no resolvable path" and blocks (fail closed).
 */
export function extractFilePath(toolInput: unknown): string | undefined {
  if (typeof toolInput !== 'object' || toolInput === null) {
    return undefined;
  }
  const record = toolInput as Record<string, unknown>;
  const candidate = record['file_path'] ?? record['notebook_path'];
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : undefined;
}

/**
 * True when `expiresAt` (ISO 8601) is at or before `now`.
 *
 * Fails closed: an unparseable `expiresAt` (`NaN` from `Date` parsing) is
 * treated as expired. Otherwise `now >= NaN` would be `false` and a malformed
 * or corrupted expiry would make the credential read as never-expired —
 * defeating the temporal security boundary. The factory validates `expiresAt`
 * at construction, so this is defense-in-depth for identities that were
 * persisted, round-tripped, or hand-built.
 */
export function isCredentialExpired(expiresAt: string, now: Date): boolean {
  const expiry = new Date(expiresAt).getTime();
  if (Number.isNaN(expiry)) {
    return true;
  }
  return now.getTime() >= expiry;
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
  /**
   * Whether the agent's `Bash` commands run inside the OS sandbox (see
   * ../sandbox/bash-sandbox.ts). Bash is denied unless this is `true`.
   */
  readonly isBashSandboxed?: boolean;
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
      ...(config.isBashSandboxed !== undefined
        ? { isBashSandboxed: config.isBashSandboxed }
        : {}),
    });

    if (decision.action === 'allow') {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
        },
      };
    }

    const denyResult: HookJSONOutput = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: decision.violation.reason,
      },
    };

    const event = buildScopeViolationEvent({
      violation: decision.violation,
      identity: config.identity,
      projectId: config.projectId,
      sessionId: preToolUse.session_id,
      id: generateEventId(),
      timestamp: now().toISOString(),
    });

    // Auditing is a side effect, not a gate (CLAUDE.md principle 4). A failure
    // to write the audit event must never turn a denied call into an allowed
    // one, so the deny decision is computed first and returned regardless of
    // whether logging succeeds. The failure is surfaced to stderr, not
    // swallowed.
    try {
      await config.auditLogger.log(event);
    } catch (error) {
      console.error(
        'scope-enforcement: failed to write audit event for a blocked tool call; denying anyway',
        error,
      );
    }

    return denyResult;
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
