/**
 * agents/tests/definitions/code-agent.test.ts
 *
 * Tests for the Phase 1 single Code Agent integration (issue #11).
 *
 * Two layers:
 *   - Definition/wiring unit tests: the identity has the expected scope,
 *     standards, and 24-hour expiry; `buildCodeAgentQueryOptions` registers the
 *     scope + audit hooks and the two MCP servers.
 *   - Integration checks against real stores: a temp-JSONL AuditLogger and a
 *     working in-memory MemoryStore, driven by simulating tool calls through
 *     the registered hooks. These mirror the issue's acceptance checks — an
 *     out-of-scope write is denied and a blocked event is read back; an
 *     in-scope write is allowed and its invoked/completed events are read back;
 *     a memory write/read round-trips — each with a negative control.
 *
 * The live-LLM path (`runCodeAgent`) is intentionally not exercised here; per
 * the testing standard LLM behavior is not unit-tested, and issue #11 covers it
 * with a one-time human integration check.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  HookCallback,
  HookJSONOutput,
  PostToolUseHookInput,
  PreToolUseHookInput,
} from '@anthropic-ai/claude-agent-sdk';

import {
  buildCodeAgentQueryOptions,
  buildCodeAgentSystemPrompt,
  createCodeAgentIdentity,
  CODE_AGENT_DEFAULT_MODEL,
  CODE_AGENT_FILE_SCOPE,
  CODE_AGENT_MCP_TOOLS,
  CODE_AGENT_READ_DENY_RULES,
  CODE_AGENT_STANDARDS,
  CODE_AGENT_TOOLS,
  type CodeAgentRuntimeConfig,
} from '../../src/definitions/code-agent.js';
import { DEFAULT_AGENT_TTL_MS } from '../../src/identity/factory.js';
import {
  MEMORY_MCP_SERVER_NAME,
  memoryRead,
  memoryToolContextFromIdentity,
  memoryWrite,
} from '../../src/mcp/memory-server.js';
import type { ReferenceResolver, ResolvedReference } from '../../src/mcp/reference-resolver.js';
import { REFERENCE_RESOLVER_MCP_SERVER_NAME } from '../../src/mcp/reference-resolver.js';
import type { BashSandboxEnvironment } from '../../src/sandbox/bash-sandbox.js';
import { InMemoryMemoryStore } from '../support/in-memory-memory-store.js';
import { JsonlAuditLogger, readAuditEvents } from '../support/jsonl-audit-logger.js';

const NOW = new Date('2026-07-01T12:00:00.000Z');
const PROJECT_ROOT = '/workspace/saor';

/**
 * A fabricated host, so the wiring does not depend on the machine running the
 * tests: a macOS box (which has an OS sandbox) and a small project tree.
 */
const SANDBOXED_HOST: BashSandboxEnvironment = {
  platform: 'darwin',
  hasCommand: () => false,
  homeDir: '/Users/dev',
  listDirectory: (absolutePath) =>
    absolutePath === PROJECT_ROOT ? ['.sdlc', 'CLAUDE.md', 'docs', 'src'] : [],
  realPath: (absolutePath) => absolutePath,
};

/** A host with no OS sandbox the SDK can use. */
const UNSANDBOXED_HOST: BashSandboxEnvironment = { ...SANDBOXED_HOST, platform: 'win32' };

function makeIdentity() {
  return createCodeAgentIdentity({
    delegatedBy: 'human:kevin',
    purpose: 'Implement #11: single Code Agent integration',
    issue: '11',
    now: NOW,
  });
}

/** A trivial resolver, only needed so the reference MCP server can be built. */
const stubResolver: ReferenceResolver = {
  async resolve(uri: string): Promise<ResolvedReference> {
    return { kind: 'content', uri, content: '' };
  },
};

describe('createCodeAgentIdentity', () => {
  it('stamps the fixed code-agent role, scope, and standards', () => {
    const identity = makeIdentity();

    expect(identity.role).toBe('code-agent');
    expect(identity.type).toBe('specialist');
    expect(identity.scope.files).toEqual(CODE_AGENT_FILE_SCOPE);
    expect(identity.scope.tools).toEqual(CODE_AGENT_TOOLS);
    expect(identity.scope.issues).toEqual(['11']);
    expect(identity.standards).toEqual(CODE_AGENT_STANDARDS);
  });

  it('grants the base editing tools plus the namespaced MCP tools', () => {
    const { tools } = makeIdentity().scope;
    for (const base of ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob']) {
      expect(tools).toContain(base);
    }
    expect(tools).toContain(`mcp__${MEMORY_MCP_SERVER_NAME}__memory_write`);
    expect(tools).toContain(`mcp__${REFERENCE_RESOLVER_MCP_SERVER_NAME}__resolve_ref`);
    expect(tools).toEqual(expect.arrayContaining([...CODE_AGENT_MCP_TOOLS]));
  });

  it('scopes memory namespaces to the store\'s real categories', () => {
    const { memoryNamespaces } = makeIdentity().scope;
    // Issue #11's "code"/"conventions" map onto the store's category vocabulary.
    expect(memoryNamespaces.read).toEqual(['convention', 'context', 'learning']);
    expect(memoryNamespaces.write).toEqual(['learning']);
  });

  it('expires 24 hours after creation by default', () => {
    const identity = makeIdentity();
    const lifetimeMs = new Date(identity.expiresAt).getTime() - new Date(identity.createdAt).getTime();
    expect(lifetimeMs).toBe(DEFAULT_AGENT_TTL_MS);
    expect(DEFAULT_AGENT_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('builds a delegation chain from the delegator to the generated id', () => {
    const identity = makeIdentity();
    expect(identity.id).toMatch(/^agent:code-agent:/);
    expect(identity.delegationChain).toEqual(['human:kevin', identity.id]);
  });
});

describe('buildCodeAgentQueryOptions wiring', () => {
  function makeOptions(overrides: Partial<CodeAgentRuntimeConfig> = {}) {
    return buildCodeAgentQueryOptions({
      identity: makeIdentity(),
      projectId: 'proj-1',
      cwd: PROJECT_ROOT,
      memoryStore: new InMemoryMemoryStore(),
      referenceResolver: stubResolver,
      auditLogger: { async log() {} },
      bashSandboxEnvironment: SANDBOXED_HOST,
      ...overrides,
    });
  }

  it('registers the scope hook and the invoked-audit hook on PreToolUse', () => {
    const options = makeOptions();
    expect(options.hooks?.PreToolUse).toHaveLength(1);
    expect(options.hooks?.PreToolUse?.[0]?.hooks).toHaveLength(2);
  });

  it('registers the completed-audit and sandbox-violation hooks on both post-tool events', () => {
    const options = makeOptions();
    expect(options.hooks?.PostToolUse?.[0]?.hooks).toHaveLength(2);
    expect(options.hooks?.PostToolUseFailure?.[0]?.hooks).toHaveLength(2);
  });

  it('sandboxes Bash to the file scope when the host has an OS sandbox', () => {
    const options = makeOptions();

    expect(options.allowedTools).toContain('Bash');
    expect(options.sandbox?.enabled).toBe(true);
    expect(options.sandbox?.allowUnsandboxedCommands).toBe(false);
    const denyWrite = options.sandbox?.filesystem?.denyWrite ?? [];
    // Out-of-scope entries of the fabricated tree are denied; `src` is not.
    expect(denyWrite).toEqual([
      `/${PROJECT_ROOT}/.sdlc`,
      `/${PROJECT_ROOT}/CLAUDE.md`,
      `/${PROJECT_ROOT}/docs`,
    ]);
    expect(options.sandbox?.filesystem?.denyRead).toContain('//Users/dev/.ssh');
  });

  it('withholds Bash entirely when the host has no OS sandbox', () => {
    const options = makeOptions({ bashSandboxEnvironment: UNSANDBOXED_HOST });

    expect(options.sandbox).toBeUndefined();
    expect(options.allowedTools).not.toContain('Bash');
    expect(options.allowedTools).toContain('Read');
    expect(options.disallowedTools).toContain('Bash');
  });

  it('registers Read deny rules for the protected paths either way', () => {
    for (const host of [SANDBOXED_HOST, UNSANDBOXED_HOST]) {
      const options = makeOptions({ bashSandboxEnvironment: host });
      expect(options.disallowedTools).toEqual(expect.arrayContaining([...CODE_AGENT_READ_DENY_RULES]));
    }
    expect(CODE_AGENT_READ_DENY_RULES).toContain('Read(./.env)');
    expect(CODE_AGENT_READ_DENY_RULES).toContain('Read(./.sdlc/**)');
  });

  it('registers both MCP servers under their server-name keys', () => {
    const options = makeOptions();
    expect(Object.keys(options.mcpServers ?? {})).toEqual([
      MEMORY_MCP_SERVER_NAME,
      REFERENCE_RESOLVER_MCP_SERVER_NAME,
    ]);
  });

  it('mirrors the scope tool allowlist into allowedTools', () => {
    const options = makeOptions();
    expect(options.allowedTools).toEqual(CODE_AGENT_TOOLS);
  });

  it('defaults the model to sonnet and passes cwd through, overridable', () => {
    expect(makeOptions().model).toBe(CODE_AGENT_DEFAULT_MODEL);
    expect(makeOptions().cwd).toBe(PROJECT_ROOT);
    expect(makeOptions({ model: 'opus' }).model).toBe('opus');
  });

  it('builds a system prompt naming the agent\'s file boundary', () => {
    const prompt = buildCodeAgentSystemPrompt(makeIdentity());
    expect(prompt).toContain('Code Agent');
    expect(prompt).toContain('agents/src/**');
  });
});

describe('Code Agent integration against real stores', () => {
  let tempDir: string;
  let auditPath: string;
  let memoryStore: InMemoryMemoryStore;
  let config: CodeAgentRuntimeConfig;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'saor-code-agent-'));
    auditPath = join(tempDir, 'audit.jsonl');
    memoryStore = new InMemoryMemoryStore();
    config = {
      identity: makeIdentity(),
      projectId: 'proj-1',
      cwd: PROJECT_ROOT,
      memoryStore,
      referenceResolver: stubResolver,
      auditLogger: new JsonlAuditLogger(auditPath),
      bashSandboxEnvironment: SANDBOXED_HOST,
      now: () => NOW,
    };
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  /** Fire every registered PreToolUse hook, in order, and return their outputs. */
  async function firePreToolUse(
    hooks: HookCallback[],
    toolName: string,
    toolInput: unknown,
    toolUseId: string,
  ): Promise<HookJSONOutput[]> {
    const input: PreToolUseHookInput = {
      hook_event_name: 'PreToolUse',
      session_id: 'session-1',
      transcript_path: '/tmp/transcript.jsonl',
      cwd: PROJECT_ROOT,
      tool_name: toolName,
      tool_input: toolInput,
      tool_use_id: toolUseId,
    };
    const outputs: HookJSONOutput[] = [];
    for (const hook of hooks) {
      outputs.push(await hook(input, toolUseId, { signal: new AbortController().signal }));
    }
    return outputs;
  }

  async function firePostToolUse(
    hooks: HookCallback[],
    toolName: string,
    toolInput: unknown,
    toolResponse: unknown,
    toolUseId: string,
  ): Promise<void> {
    const input: PostToolUseHookInput = {
      hook_event_name: 'PostToolUse',
      session_id: 'session-1',
      transcript_path: '/tmp/transcript.jsonl',
      cwd: PROJECT_ROOT,
      tool_name: toolName,
      tool_input: toolInput,
      tool_response: toolResponse,
      tool_use_id: toolUseId,
    };
    for (const hook of hooks) {
      await hook(input, toolUseId, { signal: new AbortController().signal });
    }
  }

  function permissionDecision(output: HookJSONOutput): string | undefined {
    return (output as { hookSpecificOutput?: { permissionDecision?: string } })
      .hookSpecificOutput?.permissionDecision;
  }

  it('denies a read outside the project and records a scope.violation (#56)', async () => {
    const options = buildCodeAgentQueryOptions(config);
    const preHooks = options.hooks!.PreToolUse![0]!.hooks;

    const outside = await firePreToolUse(
      preHooks,
      'Read',
      { file_path: '/Users/dev/.ssh/id_rsa' },
      'tu-read-outside',
    );
    const protectedPath = await firePreToolUse(
      preHooks,
      'Grep',
      { pattern: 'token', path: `${PROJECT_ROOT}/.sdlc` },
      'tu-read-protected',
    );
    // Negative control: an ordinary project read goes through.
    const inside = await firePreToolUse(
      preHooks,
      'Read',
      { file_path: `${PROJECT_ROOT}/docs/adr/001.md` },
      'tu-read-inside',
    );

    expect(permissionDecision(outside[0]!)).toBe('deny');
    expect(permissionDecision(protectedPath[0]!)).toBe('deny');
    expect(permissionDecision(inside[0]!)).toBe('allow');

    const violations = readAuditEvents(auditPath).filter(
      (event) => event.eventType === 'scope.violation',
    );
    expect(violations.map((event) => event.details['filePath'])).toEqual([
      '/Users/dev/.ssh/id_rsa',
      `${PROJECT_ROOT}/.sdlc`,
    ]);
  });

  it('lets sandboxed Bash run and audits what the sandbox blocked (#56)', async () => {
    const options = buildCodeAgentQueryOptions(config);
    const command = { command: 'echo x > docs/notes.md' };

    const pre = await firePreToolUse(options.hooks!.PreToolUse![0]!.hooks, 'Bash', command, 'tu-bash');
    // The hook lets the command run; confining it is the sandbox's job.
    expect(permissionDecision(pre[0]!)).toBe('allow');

    await firePostToolUse(
      options.hooks!.PostToolUse![0]!.hooks,
      'Bash',
      command,
      {
        stdout: '',
        stderr:
          'Operation not permitted\n<sandbox_violations>\ndeny file-write-create docs/notes.md\n</sandbox_violations>',
      },
      'tu-bash',
    );

    const events = readAuditEvents(auditPath).filter((event) => event.details['toolUseId'] === 'tu-bash');
    expect(events.map((event) => event.eventType)).toEqual([
      'tool.invoked',
      'tool.completed',
      'scope.violation',
    ]);
    expect(events[2]).toMatchObject({ result: 'blocked', details: { command: command.command } });
  });

  it('denies Bash and records tool.blocked when the host has no OS sandbox (#56)', async () => {
    const options = buildCodeAgentQueryOptions({
      ...config,
      bashSandboxEnvironment: UNSANDBOXED_HOST,
    });

    const pre = await firePreToolUse(
      options.hooks!.PreToolUse![0]!.hooks,
      'Bash',
      { command: 'echo x > docs/notes.md' },
      'tu-bash',
    );

    expect(permissionDecision(pre[0]!)).toBe('deny');
    const blocked = readAuditEvents(auditPath).filter((event) => event.eventType === 'tool.blocked');
    expect(blocked).toHaveLength(1);
    expect(blocked[0]!.reason).toContain('OS sandbox');
  });

  it('denies an out-of-scope write to docs/ and records a blocked event', async () => {
    const options = buildCodeAgentQueryOptions(config);
    const preHooks = options.hooks!.PreToolUse![0]!.hooks;

    const outputs = await firePreToolUse(
      preHooks,
      'Write',
      { file_path: 'docs/notes.md', content: 'nope' },
      'tool-docs',
    );

    // The scope hook (registered first) denies the call.
    expect(permissionDecision(outputs[0]!)).toBe('deny');

    const events = readAuditEvents(auditPath);
    const blocked = events.find((e) => e.eventType === 'scope.violation');
    expect(blocked).toBeDefined();
    expect(blocked?.result).toBe('blocked');
    expect(blocked?.agentRole).toBe('code-agent');
    expect(blocked?.details.filePath).toBe('docs/notes.md');
    // The audit hook still recorded the attempt (invoked), correlated by id.
    const invoked = events.find(
      (e) => e.eventType === 'tool.invoked' && e.details.toolUseId === 'tool-docs',
    );
    expect(invoked?.result).toBe('pending');
  });

  it('allows an in-scope write and records invoked + completed events', async () => {
    // Negative control for the deny above: the same hooks allow an in-scope
    // write, so the denial is not a block-everything bug.
    const options = buildCodeAgentQueryOptions(config);
    const preHooks = options.hooks!.PreToolUse![0]!.hooks;
    const postHooks = options.hooks!.PostToolUse![0]!.hooks;

    const toolInput = { file_path: 'agents/src/definitions/generated.ts', content: 'ok' };
    const outputs = await firePreToolUse(preHooks, 'Write', toolInput, 'tool-src');
    expect(permissionDecision(outputs[0]!)).toBe('allow');

    await firePostToolUse(postHooks, 'Write', toolInput, { ok: true }, 'tool-src');

    const events = readAuditEvents(auditPath).filter((e) => e.details.toolUseId === 'tool-src');
    const types = events.map((e) => e.eventType);
    expect(types).toContain('tool.invoked');
    expect(types).toContain('tool.completed');
    expect(events.find((e) => e.eventType === 'tool.completed')?.result).toBe('success');
    // No scope violation was recorded for the in-scope write.
    expect(events.some((e) => e.eventType === 'scope.violation')).toBe(false);
  });

  it('records no audit events when the audit hooks are not wired', async () => {
    // Control: fire only the scope hook (which writes only on a block) on an
    // allowed call — proving the invoked/completed events above came from the
    // audit hooks under test, not from somewhere else.
    const options = buildCodeAgentQueryOptions(config);
    const scopeHookOnly = [options.hooks!.PreToolUse![0]!.hooks[0]!];

    await firePreToolUse(
      scopeHookOnly,
      'Write',
      { file_path: 'agents/src/x.ts', content: 'ok' },
      'tool-noaudit',
    );

    expect(readAuditEvents(auditPath)).toHaveLength(0);
  });

  it('round-trips a memory write then read through the agent\'s namespaces', async () => {
    const context = memoryToolContextFromIdentity(config.identity, config.projectId);

    const writeResult = await memoryWrite(memoryStore, context, {
      category: 'learning',
      content: 'FTS5 sync triggers keep the memory index consistent',
    });
    expect(writeResult.isError).toBeUndefined();

    const readResult = await memoryRead(memoryStore, context, { query: 'FTS5' });
    expect(readResult.isError).toBeUndefined();
    const payload = JSON.parse(readResult.content[0]!.text) as {
      results: { content: string; createdBy: string }[];
    };
    expect(payload.results).toHaveLength(1);
    expect(payload.results[0]?.content).toContain('FTS5');
    expect(payload.results[0]?.createdBy).toBe(config.identity.id);
  });

  it('denies a memory write outside the agent\'s writable namespaces', async () => {
    // Negative control: the code agent may read conventions but not write them.
    const context = memoryToolContextFromIdentity(config.identity, config.projectId);

    const result = await memoryWrite(memoryStore, context, {
      category: 'convention',
      content: 'agents should never do this',
    });

    expect(result.isError).toBe(true);
    const empty = await memoryRead(memoryStore, context, { query: 'never' });
    const payload = JSON.parse(empty.content[0]!.text) as { results: unknown[] };
    expect(payload.results).toHaveLength(0);
  });

  it('stamps audit events with the injected clock', async () => {
    // The config injects `now: () => NOW`; buildCodeAgentQueryOptions must
    // thread it into the hooks, or events would carry wall-clock timestamps.
    const options = buildCodeAgentQueryOptions(config);
    const preHooks = options.hooks!.PreToolUse![0]!.hooks;
    const postHooks = options.hooks!.PostToolUse![0]!.hooks;

    const toolInput = { file_path: 'agents/src/definitions/clock.ts', content: 'ok' };
    await firePreToolUse(preHooks, 'Write', toolInput, 'tool-clock');
    await firePostToolUse(postHooks, 'Write', toolInput, { ok: true }, 'tool-clock');

    const events = readAuditEvents(auditPath);
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(event.timestamp).toBe(NOW.toISOString());
    }
  });

  it('denies every tool call once the identity has expired and logs it', async () => {
    // Drive an expired code-agent identity through the wiring: the file and
    // tool checks pass for an in-scope Write, so the denial can only come from
    // the expiry check — proving buildCodeAgentQueryOptions wired `now` into the
    // scope hook's expiry evaluation.
    const createdAt = new Date(NOW.getTime() - 60 * 60 * 1000); // 1h before NOW
    const expiredIdentity = createCodeAgentIdentity({
      delegatedBy: 'human:kevin',
      purpose: 'expired-agent test',
      issue: '11',
      now: createdAt,
      ttlMs: 1000, // expires 1s after creation — well before NOW
    });
    const options = buildCodeAgentQueryOptions({ ...config, identity: expiredIdentity });
    const preHooks = options.hooks!.PreToolUse![0]!.hooks;

    const outputs = await firePreToolUse(
      preHooks,
      'Write',
      { file_path: 'agents/src/definitions/in-scope.ts', content: 'ok' },
      'tool-expired',
    );
    expect(permissionDecision(outputs[0]!)).toBe('deny');

    const expiredEvent = readAuditEvents(auditPath).find(
      (e) => e.eventType === 'credential.expired',
    );
    expect(expiredEvent?.result).toBe('blocked');
    expect(expiredEvent?.agentId).toBe(expiredIdentity.id);
  });

  it('allows a granted MCP tool but blocks a tool absent from scope.tools', async () => {
    // The reason MCP tool names are added to scope.tools is that a tool not on
    // the allowlist is denied. Assert both directions through the wiring: a
    // granted memory tool is allowed; an ungranted tool is blocked and logged.
    const options = buildCodeAgentQueryOptions(config);
    const preHooks = options.hooks!.PreToolUse![0]!.hooks;

    const grantedOut = await firePreToolUse(
      preHooks,
      `mcp__${MEMORY_MCP_SERVER_NAME}__memory_read`,
      { query: 'anything' },
      'tool-granted',
    );
    expect(permissionDecision(grantedOut[0]!)).toBe('allow');

    const blockedOut = await firePreToolUse(
      preHooks,
      'WebFetch',
      { url: 'https://example.com' },
      'tool-ungranted',
    );
    expect(permissionDecision(blockedOut[0]!)).toBe('deny');

    // Scope-violation events carry the tool in details but not the toolUseId
    // (that correlation key is stamped by the audit hooks, not the scope hook),
    // and only the ungranted call produces a tool.blocked event.
    const blockedEvent = readAuditEvents(auditPath).find((e) => e.eventType === 'tool.blocked');
    expect(blockedEvent?.result).toBe('blocked');
    expect(blockedEvent?.details.tool).toBe('WebFetch');
  });
});
