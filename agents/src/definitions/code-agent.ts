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
 * here. What enforces that, per tool (issue #56, ADR-010):
 *
 *   - `Write` / `Edit` outside the file globs, and any tool not on the
 *     allowlist, are blocked by the PreToolUse scope-enforcement hook and
 *     logged to the audit trail.
 *   - `Read` / `Grep` / `Glob` are held to the project root and kept away from
 *     protected paths by the same hook, backed by `Read(...)` deny rules for
 *     searches that sweep a whole directory.
 *   - `Bash` runs inside the OS sandbox built by ../sandbox/bash-sandbox.ts: it
 *     cannot write outside the project, cannot modify existing files outside
 *     the file scope (build output directories excepted), cannot read protected
 *     paths, and has no network. That module's header lists the limits. Where
 *     no OS sandbox is available, Bash is withheld entirely.
 *
 *   - Branch scope (issue #58, ADR-011): the agent may change files only while
 *     the checked-out branch matches `scope.branches`, which defaults to the
 *     feature branches of its issue. On such a branch it may also commit: the
 *     sandbox opens `.git` to Bash except for the files that would let a
 *     command switch branches or alter another one.
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
import { readBranchState, type BranchState } from '../git/branch-state.js';
import type { AgentIdentity, AgentScope, MemoryNamespaceScope } from '../identity/types.js';
import type { AuditLogger } from '../hooks/audit-logger.js';
import {
  createToolCompletedAuditHook,
  createToolInvokedAuditHook,
} from '../hooks/audit-logger.js';
import { createSandboxViolationAuditHook } from '../hooks/sandbox-violation-audit.js';
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
import {
  BASH_BUILD_OUTPUT_DIRS,
  buildBashSandboxSettings,
  isBashSandboxAvailable,
  type BashSandboxEnvironment,
} from '../sandbox/bash-sandbox.js';
import { resolveBashGitAccess, type BashGitAccess } from '../sandbox/git-access.js';
import { PROTECTED_PROJECT_GLOBS } from '../sandbox/protected-paths.js';
import { systemBashSandboxEnvironment } from '../sandbox/system-environment.js';

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

/**
 * Branch scope for an agent launched with no issue to derive one from: any
 * branch named like a feature branch (`{issue}/{description}`). It matches no
 * single-segment name, so `main` is never in scope by default.
 */
export const ANY_FEATURE_BRANCH = '*/*';

/**
 * The branches a Code Agent is scoped to when the caller names none: the
 * feature branches of the issue it is working on (`{issue}/*`, the project's
 * branch-naming convention), or any feature branch when there is no issue.
 *
 * Never `main`: work reaches `main` through a reviewed pull request, so an
 * agent has no reason to be writing there.
 */
export function defaultCodeAgentBranches(issue: string | undefined): readonly string[] {
  return [issue !== undefined && issue.length > 0 ? `${issue}/*` : ANY_FEATURE_BRANCH];
}

/** Caller-supplied inputs for constructing a Code Agent identity. */
export interface CodeAgentIdentityOptions {
  /** Parent agent or user id spawning this agent, e.g. "human:kevin". */
  readonly delegatedBy: string;
  /** Why this agent exists, e.g. "Implement #11: single Code Agent integration". */
  readonly purpose: string;
  /**
   * The issue this agent is acting on, e.g. "11". Recorded as the single
   * in-scope issue (and used to stamp audit events with an issue reference).
   *
   * Optional because a launch from the UI does not yet name one (`agent_start`
   * carries only a task). Without it the agent has no in-scope issue and its
   * audit events carry no `issueRef`.
   */
  readonly issue?: string;
  /**
   * Explicit identity id. Defaults to a generated `agent:code-agent:{uuid}`.
   */
  readonly id?: string;
  /**
   * Git branches the agent may work on, as globs. Defaults to the feature
   * branches of `issue` (see {@link defaultCodeAgentBranches}).
   */
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
    issues: options.issue !== undefined ? [options.issue] : [],
    files: CODE_AGENT_FILE_SCOPE,
    branches: options.branches ?? defaultCodeAgentBranches(options.issue),
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
    `You may work only while one of these branches is checked out: ${identity.scope.branches.join(', ')}. You may commit to the branch that is checked out. You cannot switch branches, change any other branch, or push — do not try.`,
    'Shell commands run in a sandbox: they cannot change files outside that boundary (build output aside), cannot read credentials or the .sdlc directory, and have no network access. A command that fails for one of these reasons is working as intended.',
    'Use the memory tools to record durable learnings and to read project conventions and context before you start.',
    `Resolve and follow the standards that apply to your work: ${standards}. Use resolve_ref to read them.`,
    'Every artifact you produce must carry its traceability references (issue, related ADRs/PRs).',
  ].join('\n\n');
}

/**
 * The ports and runtime context needed to wire the Code Agent to its backends.
 * The stores are injected through their ports (CLAUDE.md principle 5) so the
 * same wiring works against the in-process test stores and the bridge-backed
 * adapters a launched agent uses (agents/src/bridge/adapters.ts).
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
  /**
   * The host facts sandboxing Bash depends on (platform, installed commands,
   * home directory, directory listings). Defaults to the real machine;
   * injected for deterministic tests.
   */
  readonly bashSandboxEnvironment?: BashSandboxEnvironment;
}

/** The shell tool's name, as it appears in tool allowlists. */
const BASH_TOOL = 'Bash';

/**
 * `Read(...)` deny rules for the protected project paths. The scope hook checks
 * the path a read names; these rules are what the SDK applies to a `Grep` or
 * `Glob` that sweeps a directory containing a protected file.
 */
export const CODE_AGENT_READ_DENY_RULES: readonly string[] = PROTECTED_PROJECT_GLOBS.map(
  (glob) => `Read(./${glob})`,
);

/**
 * The `git` part of the sandbox input: present when the agent may commit on the
 * branch checked out at launch, absent (leaving `.git` unwritable) otherwise.
 */
function gitAccessFor(
  projectRoot: string,
  identity: AgentIdentity,
  environment: BashSandboxEnvironment,
): { git?: BashGitAccess } {
  const git = resolveBashGitAccess({
    projectRoot,
    branchScope: identity.scope.branches,
    readTextFile: environment.readTextFile,
    listDirectory: environment.listDirectory,
  });
  return git !== undefined ? { git } : {};
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
 *   - PostToolUse / PostToolUseFailure: the `tool.completed` audit hook, and
 *     the hook that records a `scope.violation` when the sandbox blocked part
 *     of a Bash command.
 *   - sandbox: the OS sandbox settings confining Bash to the agent's file scope
 *     (see ../sandbox/bash-sandbox.ts). When the host has no OS sandbox, the
 *     settings are omitted and Bash is withheld instead: dropped from
 *     `allowedTools`, added to `disallowedTools`, and denied by the scope hook.
 *   - disallowedTools: `Read(...)` deny rules for the protected paths.
 *
 * The checked-out branch is read twice, for two different jobs. The scope hook
 * reads it before every write, to decide whether the agent may write at all.
 * The sandbox settings are built once, here, from the branch at launch: if it
 * is in scope, Bash is given the limited `.git` access that makes commits
 * possible (see ../sandbox/git-access.ts).
 *   - mcpServers: the memory and reference-resolver in-process servers, keyed
 *     by their server names so the granted `mcp__…` tool names line up.
 *   - allowedTools: the same allowlist the scope hook enforces, so the SDK and
 *     the hook agree on what the agent may call.
 *
 * The returned options are ready to pass to {@link runCodeAgent} or `query()`.
 */
export function buildCodeAgentQueryOptions(config: CodeAgentRuntimeConfig): Options {
  const { identity, projectId, auditLogger } = config;

  const environment = config.bashSandboxEnvironment ?? systemBashSandboxEnvironment();
  const isBashSandboxed = isBashSandboxAvailable(environment);

  const readCurrentBranch = (directory: string): BranchState =>
    readBranchState(directory, environment.readTextFile);

  const hookConfig = {
    identity,
    auditLogger,
    projectId,
    isBashSandboxed,
    readCurrentBranch,
    ...(config.now !== undefined ? { now: config.now } : {}),
    ...(config.generateEventId !== undefined
      ? { generateEventId: config.generateEventId }
      : {}),
  };

  const scopeHook = createScopeEnforcementHook(hookConfig);
  const toolInvokedHook = createToolInvokedAuditHook(hookConfig);
  const toolCompletedHook = createToolCompletedAuditHook(hookConfig);
  const sandboxViolationHook = createSandboxViolationAuditHook(hookConfig);

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
    allowedTools: identity.scope.tools.filter((tool) => isBashSandboxed || tool !== BASH_TOOL),
    disallowedTools: [...CODE_AGENT_READ_DENY_RULES, ...(isBashSandboxed ? [] : [BASH_TOOL])],
    ...(isBashSandboxed
      ? {
          sandbox: buildBashSandboxSettings({
            projectRoot: config.cwd,
            realProjectRoot: environment.realPath(config.cwd),
            ...gitAccessFor(config.cwd, identity, environment),
            writableGlobs: identity.scope.files,
            buildOutputDirs: BASH_BUILD_OUTPUT_DIRS,
            homeDir: environment.homeDir,
            listDirectory: environment.listDirectory,
          }),
        }
      : {}),
    mcpServers: {
      [MEMORY_MCP_SERVER_NAME]: memoryServer,
      [REFERENCE_RESOLVER_MCP_SERVER_NAME]: referenceServer,
    },
    hooks: {
      // The scope hook is registered before the audit-invoked hook so a denial
      // decision is computed first, but both run — auditing never gates the
      // permission decision (CLAUDE.md principle 4).
      PreToolUse: [{ hooks: [scopeHook, toolInvokedHook] }],
      PostToolUse: [{ hooks: [toolCompletedHook, sandboxViolationHook] }],
      PostToolUseFailure: [{ hooks: [toolCompletedHook, sandboxViolationHook] }],
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
