/**
 * agents/src/definitions/code-agent.ts
 *
 * Agent definition for the Code Agent — the specialist responsible for
 * writing and refactoring source code. In Phase 1, this is the single
 * agent integration used to validate the identity, scope enforcement,
 * and audit hook infrastructure end to end (issue #11): one agent with a
 * real identity, real scope enforcement, real audit logging, real memory
 * access, and real reference resolution.
 *
 * The module is split into three layers, so the deterministic parts can be
 * unit-tested without a live LLM:
 *
 *   - Scope constants + `createCodeAgentIdentity` — the Code Agent's fixed
 *     identity (role, tools, file globs, memory namespaces, standards) and the
 *     factory that stamps a delegation chain and a 24-hour expiry onto it.
 *   - `buildCodeAgentQueryOptions` — assembles the SDK `Options` that wire the
 *     identity to its runtime: the scope-enforcement PreToolUse hook (#7), the
 *     audit hooks (#10), and the memory (#8) and reference-resolver (#9) MCP
 *     servers, all against injected ports.
 *   - `runCodeAgent` — the thin adapter that hands those options to the SDK's
 *     `query()`. This is the only part that talks to a live LLM; it is exercised
 *     by the one-time human integration check, not the unit suite.
 *
 * The Code Agent's scope is restricted to the file globs and tools defined
 * here. Attempts to write outside the allowed globs or invoke disallowed
 * tools are blocked by the PreToolUse scope-enforcement hook and logged to the
 * audit trail.
 *
 * Two details of the scope deviate from the literal text of issue #11, because
 * the concrete memory store (#8) and scope hook (#7) that landed after the
 * issue was written constrain what actually round-trips:
 *
 *   - Memory namespaces use the store's real category vocabulary
 *     (`learning | convention | context | index`), since `memoryNamespaces`
 *     is checked against `MemoryEntry.category`. The issue's `"code"` /
 *     `"conventions"` map onto `learning` (the agent's own working notes) and
 *     `convention` (shared project conventions); `context` is granted for
 *     orientation. See {@link CODE_AGENT_MEMORY_NAMESPACES}.
 *   - `scope.tools` grants the MCP tool names in addition to the base editing
 *     tools, because the scope hook gate-checks *every* tool name — an MCP tool
 *     not in the allowlist would be blocked before it could run. See
 *     {@link CODE_AGENT_TOOLS}.
 *
 * See docs/architecture/sdlc-agent-architecture-research-v4.md Section 3.4
 * for the full agent definition table, Section 7 for the identity schema, and
 * Section 10 for the Phase 1 single-agent integration goal.
 */

import type { Options, Query } from '@anthropic-ai/claude-agent-sdk';
import { query } from '@anthropic-ai/claude-agent-sdk';

import { createAgentIdentity } from '../identity/factory.js';
import type { AgentIdentity, AgentScope, MemoryNamespaceScope } from '../identity/types.js';
import type { AuditLogger } from '../hooks/audit-logger.js';
import {
  createToolCompletedAuditHook,
  createToolInvokedAuditHook,
} from '../hooks/audit-logger.js';
import { createScopeEnforcementHook } from '../hooks/scope-enforcement.js';
import {
  createMemoryMcpServer,
  memoryToolContextFromIdentity,
  MEMORY_MCP_SERVER_NAME,
} from '../mcp/memory-server.js';
import type { MemoryStore, MemoryToolDeps } from '../mcp/memory-server.js';
import {
  createReferenceResolverMcpServer,
  REFERENCE_RESOLVER_MCP_SERVER_NAME,
} from '../mcp/reference-resolver.js';
import type { ReferenceResolver } from '../mcp/reference-resolver.js';

/** The Code Agent's role, stamped onto its identity and audit events. */
export const CODE_AGENT_ROLE = 'code-agent';

/**
 * The base editing tools the Code Agent is granted (issue #11, architecture
 * Section 3.4). These are the built-in SDK tools it uses to read and mutate
 * source.
 */
export const CODE_AGENT_BASE_TOOLS: readonly string[] = [
  'Read',
  'Write',
  'Edit',
  'Bash',
  'Grep',
  'Glob',
];

/**
 * The MCP tool names the Code Agent may call. The SDK namespaces an in-process
 * MCP tool as `mcp__{serverName}__{toolName}`, so these are derived from the
 * exported server-name constants to stay in lock-step with how the servers are
 * registered in {@link buildCodeAgentQueryOptions}.
 *
 * These must be granted explicitly: the scope-enforcement hook checks every
 * tool name against `scope.tools`, so an MCP tool absent from the allowlist
 * would be denied before it could run — the agent could never reach memory or
 * reference resolution.
 */
export const CODE_AGENT_MCP_TOOLS: readonly string[] = [
  `mcp__${MEMORY_MCP_SERVER_NAME}__memory_read`,
  `mcp__${MEMORY_MCP_SERVER_NAME}__memory_write`,
  `mcp__${MEMORY_MCP_SERVER_NAME}__memory_context`,
  `mcp__${REFERENCE_RESOLVER_MCP_SERVER_NAME}__resolve_ref`,
];

/**
 * The full tool allowlist for the Code Agent: base editing tools plus the
 * granted MCP tools. Used both as `scope.tools` (enforced by the scope hook)
 * and as the SDK `allowedTools` (so the two agree).
 */
export const CODE_AGENT_TOOLS: readonly string[] = [
  ...CODE_AGENT_BASE_TOOLS,
  ...CODE_AGENT_MCP_TOOLS,
];

/**
 * File globs the Code Agent may write to (issue #11): the three source trees.
 * Docs, standards, and config are deliberately excluded — an attempt to write
 * there is blocked and audited.
 */
export const CODE_AGENT_FILE_SCOPE: readonly string[] = [
  'src/**',
  'src-tauri/src/**',
  'agents/src/**',
];

/**
 * Memory namespaces the Code Agent may read and write. Expressed in the memory
 * store's real category vocabulary (see the module note): it reads shared
 * `convention`s and cross-cutting `context` to orient, plus its own
 * `learning`s, and writes only `learning`s (its own working notes and
 * discoveries). It cannot mutate shared conventions or the searchable index.
 */
export const CODE_AGENT_MEMORY_NAMESPACES: MemoryNamespaceScope = {
  read: ['convention', 'context', 'learning'],
  write: ['learning'],
};

/**
 * Standards resolved onto the Code Agent (issue #11). These are reference
 * paths, resolved on demand through the three-tier chain by the reference
 * resolver — not read here.
 */
export const CODE_AGENT_STANDARDS: readonly string[] = [
  'coding-standards/typescript',
  'coding-standards/rust',
  'process-standards/testing-requirements',
  'documentation-standards/commit-conventions',
];

/** The default branch a Code Agent is scoped to when the caller names none. */
const DEFAULT_CODE_AGENT_BRANCHES: readonly string[] = ['main'];

/** Caller-supplied inputs for constructing a Code Agent identity. */
export interface CodeAgentIdentityOptions {
  /** Parent agent or user id spawning this agent, e.g. "human:kevin". */
  readonly delegatedBy: string;
  /** Why this agent exists, e.g. "Implement #11: single Code Agent integration". */
  readonly purpose: string;
  /**
   * The issue this agent is acting on, e.g. "11". Recorded as the single
   * in-scope issue (and used to stamp audit events with an issue reference).
   */
  readonly issue: string;
  /**
   * Explicit identity id. Defaults to a generated `agent:code-agent:{uuid}`.
   */
  readonly id?: string;
  /** Git branches the agent may work on. Defaults to `["main"]`. */
  readonly branches?: readonly string[];
  /** The spawning parent's delegation chain, appended to for this agent. */
  readonly parentDelegationChain?: readonly string[];
  /**
   * Lifetime in milliseconds. Defaults to the factory's 24-hour TTL — agents
   * do not live forever (issue #11: `expiresAt` 24 hours from creation).
   */
  readonly ttlMs?: number;
  /** Current time, for deterministic tests. Defaults to the system clock. */
  readonly now?: Date;
}

/**
 * Construct the Code Agent's {@link AgentIdentity}: the fixed role, tool
 * allowlist, file scope, memory namespaces, and standards, combined with the
 * caller's delegation and issue context. The 24-hour expiry is the factory
 * default; the identity is a plain immutable object and is not persisted here.
 */
export function createCodeAgentIdentity(
  options: CodeAgentIdentityOptions,
): AgentIdentity {
  const scope: AgentScope = {
    issues: [options.issue],
    files: CODE_AGENT_FILE_SCOPE,
    branches: options.branches ?? DEFAULT_CODE_AGENT_BRANCHES,
    tools: CODE_AGENT_TOOLS,
    memoryNamespaces: CODE_AGENT_MEMORY_NAMESPACES,
  };

  return createAgentIdentity(
    {
      ...(options.id !== undefined ? { id: options.id } : {}),
      type: 'specialist',
      role: CODE_AGENT_ROLE,
      delegatedBy: options.delegatedBy,
      purpose: options.purpose,
      scope,
      standards: CODE_AGENT_STANDARDS,
      ...(options.parentDelegationChain !== undefined
        ? { parentDelegationChain: options.parentDelegationChain }
        : {}),
      ...(options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {}),
    },
    options.now !== undefined ? { now: options.now } : {},
  );
}

/**
 * Compose the Code Agent's system prompt from its identity. Names the role,
 * the work it is delegated, the file boundary it must stay within, and the
 * standards it must resolve and follow. Kept concise — the standards
 * themselves are pulled on demand via `resolve_ref`, not inlined here.
 */
export function buildCodeAgentSystemPrompt(identity: AgentIdentity): string {
  const files = identity.scope.files.join(', ');
  const standards = identity.standards.map((s) => `standards://${s}`).join(', ');
  return [
    'You are the Code Agent, a software implementation specialist in the Saor SDLC platform.',
    `Your purpose: ${identity.purpose}`,
    `You may create and edit files only within: ${files}. Attempts to write elsewhere are blocked and audited — do not try to work around this.`,
    'Use the memory tools to record durable learnings and to read project conventions and context before you start.',
    `Resolve and follow the standards that apply to your work: ${standards}. Use resolve_ref to read them.`,
    'Every artifact you produce must carry its traceability references (issue, related ADRs/PRs).',
  ].join('\n\n');
}

/**
 * The ports and runtime context needed to wire the Code Agent to its backends.
 * The stores are injected through their ports (CLAUDE.md principle 5) so the
 * same wiring works against the in-process test stores today and the
 * IPC-backed adapters that land with issue #12.
 */
export interface CodeAgentRuntimeConfig {
  /** The Code Agent's identity (see {@link createCodeAgentIdentity}). */
  readonly identity: AgentIdentity;
  /** Project the agent acts within — scopes memory and stamps audit events. */
  readonly projectId: string;
  /**
   * Project root, used by the scope hook to resolve absolute tool paths to
   * project-relative ones before glob matching. Also the agent's working dir.
   */
  readonly cwd: string;
  /** Backing store for the memory MCP tools. */
  readonly memoryStore: MemoryStore;
  /** Resolver behind the `resolve_ref` MCP tool. */
  readonly referenceResolver: ReferenceResolver;
  /** Sink for audit events emitted by the scope and audit hooks. */
  readonly auditLogger: AuditLogger;
  /** Model to run the agent on. Defaults to `"sonnet"`. */
  readonly model?: Options['model'];
  /** Clock for hook timestamps and expiry checks. Defaults to the system clock. */
  readonly now?: () => Date;
  /** Audit event id generator. Defaults to a random UUID. */
  readonly generateEventId?: () => string;
  /** Memory tool id/clock injection, for deterministic tests. */
  readonly memoryDeps?: MemoryToolDeps;
}

/** The Code Agent's default model. */
export const CODE_AGENT_DEFAULT_MODEL = 'sonnet';

/**
 * Assemble the SDK {@link Options} that wire the Code Agent to its runtime:
 *
 *   - PreToolUse: the scope-enforcement hook (denies out-of-scope calls and
 *     audits them) and the `tool.invoked` audit hook (records every attempt).
 *     Both fire on every tool call; a scope denial still records `tool.invoked`
 *     plus `tool.blocked`, and no `tool.completed` follows (see ADR-006).
 *   - PostToolUse / PostToolUseFailure: the `tool.completed` audit hook.
 *   - mcpServers: the memory and reference-resolver in-process servers, keyed
 *     by their server names so the granted `mcp__…` tool names line up.
 *   - allowedTools: the same allowlist the scope hook enforces, so the SDK and
 *     the hook agree on what the agent may call.
 *
 * The returned options are ready to pass to {@link runCodeAgent} or `query()`.
 */
export function buildCodeAgentQueryOptions(config: CodeAgentRuntimeConfig): Options {
  const { identity, projectId, auditLogger } = config;

  const hookConfig = {
    identity,
    auditLogger,
    projectId,
    ...(config.now !== undefined ? { now: config.now } : {}),
    ...(config.generateEventId !== undefined
      ? { generateEventId: config.generateEventId }
      : {}),
  };

  const scopeHook = createScopeEnforcementHook(hookConfig);
  const toolInvokedHook = createToolInvokedAuditHook(hookConfig);
  const toolCompletedHook = createToolCompletedAuditHook(hookConfig);

  const memoryServer = createMemoryMcpServer({
    store: config.memoryStore,
    context: memoryToolContextFromIdentity(identity, projectId),
    ...(config.memoryDeps ?? {}),
  });
  const referenceServer = createReferenceResolverMcpServer({
    resolver: config.referenceResolver,
  });

  return {
    systemPrompt: buildCodeAgentSystemPrompt(identity),
    model: config.model ?? CODE_AGENT_DEFAULT_MODEL,
    cwd: config.cwd,
    allowedTools: [...identity.scope.tools],
    mcpServers: {
      [MEMORY_MCP_SERVER_NAME]: memoryServer,
      [REFERENCE_RESOLVER_MCP_SERVER_NAME]: referenceServer,
    },
    hooks: {
      // The scope hook is registered before the audit-invoked hook so a denial
      // decision is computed first, but both run — auditing never gates the
      // permission decision (CLAUDE.md principle 4).
      PreToolUse: [{ hooks: [scopeHook, toolInvokedHook] }],
      PostToolUse: [{ hooks: [toolCompletedHook] }],
      PostToolUseFailure: [{ hooks: [toolCompletedHook] }],
    },
  };
}

/**
 * Instantiate and run the Code Agent on a task prompt. A thin adapter over the
 * SDK's `query()` with the wired options — the only part of this module that
 * reaches a live LLM. Returns the SDK `Query` so the caller can iterate the
 * message stream and drive the session.
 */
export function runCodeAgent(prompt: string, config: CodeAgentRuntimeConfig): Query {
  return query({ prompt, options: buildCodeAgentQueryOptions(config) });
}
