/**
 * agents/tests/sidecar-runner.test.ts
 *
 * Tests for the sidecar's run logic (issue #59): launch arguments become a Code
 * Agent wired to the storage bridge, the run's outcome is reported on a status
 * line, and the exit code follows it. Also that the run is recorded to the
 * session transcript as it happens (issue #78).
 *
 * The LLM is not involved. `runSidecar` takes its agent runner as a dependency,
 * so these tests pass a scripted runner that uses the ports it is handed the
 * way the real agent's hooks and tools would, then yields a final SDK `result`
 * message. The Rust end of the bridge is a scripted fake host over in-memory
 * streams.
 */

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';

import type { CodeAgentRuntimeConfig } from '../src/definitions/code-agent.js';
import type { AuditEvent } from '../src/hooks/audit-logger.js';
import {
  describeInvalidArgs,
  EXIT_COMPLETED,
  EXIT_FAILED,
  parseSidecarArgs,
  runSidecar,
  type AgentRunner,
} from '../src/sidecar-runner.js';
import {
  createFakeBridgeHost,
  type FakeBridgeHost,
  type FakeHandler,
} from './support/fake-bridge-host.js';

const LAUNCH_ARGV = [
  '--session',
  'session-1',
  '--project',
  'proj-1',
  '--project-path',
  '/workspace/proj',
  '--agent-type',
  'code-agent',
  '--task',
  'Add a README',
];

/**
 * A final SDK result message. Only the fields the sidecar reads are filled in;
 * the SDK type carries usage accounting that is irrelevant here, hence the cast.
 */
function resultMessage(fields: Record<string, unknown>): SDKMessage {
  return { type: 'result', session_id: 'sdk-session-abc', ...fields } as unknown as SDKMessage;
}

const SUCCESS = resultMessage({ subtype: 'success', is_error: false, num_turns: 3, result: 'ok' });

/** An assistant message with the given content blocks. */
function assistantMessage(content: readonly Record<string, unknown>[]): SDKMessage {
  return {
    type: 'assistant',
    session_id: 'sdk-session-abc',
    parent_tool_use_id: null,
    message: { role: 'assistant', content },
  } as unknown as SDKMessage;
}

/** The transcript entries a fake host received, in order. */
function transcriptEntries(host: FakeBridgeHost): Record<string, unknown>[] {
  return host.requests
    .filter((request) => request.method === 'transcript.append')
    .map((request) => (request.params as { entry: Record<string, unknown> }).entry);
}

/** A runner that yields the given messages and records the config it was given. */
function scriptedRunner(messages: readonly SDKMessage[]) {
  const seen: { prompt?: string; config?: CodeAgentRuntimeConfig } = {};
  const runAgent: AgentRunner = async function* (prompt, config) {
    seen.prompt = prompt;
    seen.config = config;
    yield* messages;
  };
  return { runAgent, seen };
}

async function run(runAgent: AgentRunner, argv: readonly string[] = LAUNCH_ARGV, handler?: FakeHandler) {
  const host = createFakeBridgeHost(handler);
  const exitCode = await runSidecar({ argv, input: host.input, output: host.output, runAgent });
  // Let the host finish reading what the sidecar wrote before asserting on it.
  await expect.poll(() => host.statuses.at(-1)?.['status']).toMatch(/completed|failed/);
  return { host, exitCode };
}

describe('parseSidecarArgs', () => {
  it('reads the launch flags the Rust spawner passes', () => {
    expect(parseSidecarArgs(LAUNCH_ARGV)).toEqual({
      session: 'session-1',
      project: 'proj-1',
      projectPath: '/workspace/proj',
      agentType: 'code-agent',
      task: 'Add a README',
    });
  });

  it('reports missing arguments and unsupported agent types', () => {
    expect(describeInvalidArgs(parseSidecarArgs(LAUNCH_ARGV))).toBeUndefined();
    expect(describeInvalidArgs(parseSidecarArgs(['--agent-type', 'code-agent']))).toContain(
      '--session, --project, --project-path, --task',
    );
    const wrongType = LAUNCH_ARGV.map((token) => (token === 'code-agent' ? 'test-agent' : token));
    expect(describeInvalidArgs(parseSidecarArgs(wrongType))).toContain('unsupported agent type');
  });
});

describe('runSidecar', () => {
  it('runs the agent on the task and reports started then completed', async () => {
    const { runAgent, seen } = scriptedRunner([SUCCESS]);

    const { host, exitCode } = await run(runAgent);

    expect(exitCode).toBe(EXIT_COMPLETED);
    expect(seen.prompt).toBe('Add a README');
    expect(host.statuses.map((status) => status['status'])).toEqual(['started', 'completed']);
    expect(host.statuses[1]).toMatchObject({ session: 'session-1', numTurns: 3 });
  });

  it('gives the agent the identity Rust uses for its lifecycle events', async () => {
    const { runAgent, seen } = scriptedRunner([SUCCESS]);

    await run(runAgent);

    const config = seen.config!;
    expect(config.projectId).toBe('proj-1');
    expect(config.cwd).toBe('/workspace/proj');
    expect(config.identity.id).toBe('agent:code-agent:session-1');
    expect(config.identity.delegationChain).toEqual(['human:local', 'agent:code-agent:session-1']);
    expect(config.identity.purpose).toBe('Add a README');
    // A UI launch names no issue yet, so none is in scope.
    expect(config.identity.scope.issues).toEqual([]);
  });

  it('routes the agent ports through the bridge, bound to the launch session', async () => {
    const stored = {
      id: 'e1',
      projectId: 'proj-1',
      category: 'learning',
      content: 'found it',
      metadata: {},
      createdBy: 'agent:code-agent:session-1',
      createdAt: '2026-11-23T12:00:00.000Z',
      weight: 1,
    };
    const handler: FakeHandler = (request) => {
      if (request.method === 'memory.search') return { ok: true, result: [stored] };
      if (request.method === 'reference.resolve') {
        return { ok: true, result: { kind: 'content', uri: 'file://a.md', content: 'A' } };
      }
      return { ok: true, result: null };
    };
    const observed: unknown[] = [];
    const runAgent: AgentRunner = async function* (_prompt, config) {
      const event: AuditEvent = {
        id: 'evt-1',
        timestamp: '2026-11-23T12:00:00.000Z',
        projectId: config.projectId,
        agentId: config.identity.id,
        agentRole: config.identity.role,
        delegationChain: config.identity.delegationChain,
        eventType: 'tool.invoked',
        action: 'Read',
        details: {},
        sessionId: 'sdk-session-abc',
        result: 'pending',
      };
      await config.auditLogger.log(event);
      observed.push(await config.memoryStore.keywordSearch('found'));
      observed.push(await config.referenceResolver.resolve('file://a.md'));
      yield SUCCESS;
    };

    const { host, exitCode } = await run(runAgent, LAUNCH_ARGV, handler);

    expect(exitCode).toBe(EXIT_COMPLETED);
    const portRequests = host.requests.filter((request) => request.method !== 'transcript.append');
    expect(portRequests.map((request) => request.method)).toEqual([
      'audit.log',
      'memory.search',
      'reference.resolve',
    ]);
    // The audit event carries the Saor session id, not the SDK's.
    expect(portRequests[0]!.params).toMatchObject({
      event: { sessionId: 'session-1', details: { sdkSessionId: 'sdk-session-abc' } },
    });
    expect(observed).toEqual([
      [stored],
      { kind: 'content', uri: 'file://a.md', content: 'A' },
    ]);
  });

  it('reports failed with the SDK error when the run ends in an error result', async () => {
    const { runAgent } = scriptedRunner([
      resultMessage({
        subtype: 'error_max_turns',
        is_error: true,
        num_turns: 50,
        errors: ['turn limit reached', 'giving up'],
      }),
    ]);

    const { host, exitCode } = await run(runAgent);

    expect(exitCode).toBe(EXIT_FAILED);
    expect(host.statuses.at(-1)).toMatchObject({
      status: 'failed',
      error: 'turn limit reached; giving up',
    });
  });

  it('falls back to the result subtype when the SDK gives no error text', async () => {
    const { runAgent } = scriptedRunner([
      resultMessage({ subtype: 'error_during_execution', is_error: true, errors: [] }),
    ]);

    const { host } = await run(runAgent);

    expect(host.statuses.at(-1)).toMatchObject({ error: 'error_during_execution' });
  });

  it('reports failed when the runner throws', async () => {
    const runAgent: AgentRunner = async function* () {
      throw new Error('could not start the Claude CLI');
    };

    const { host, exitCode } = await run(runAgent);

    expect(exitCode).toBe(EXIT_FAILED);
    expect(host.statuses.map((status) => status['status'])).toEqual(['started', 'failed']);
    expect(host.statuses.at(-1)).toMatchObject({ error: 'could not start the Claude CLI' });
  });

  it('reports failed when the stream ends without a result', async () => {
    const { runAgent } = scriptedRunner([]);

    const { host, exitCode } = await run(runAgent);

    expect(exitCode).toBe(EXIT_FAILED);
    expect(host.statuses.at(-1)).toMatchObject({
      status: 'failed',
      error: 'the agent run ended without reporting a result',
    });
  });

  it('refuses a bad launch without starting the agent', async () => {
    const { runAgent, seen } = scriptedRunner([SUCCESS]);

    const { host, exitCode } = await run(runAgent, ['--session', 'session-1']);

    expect(exitCode).toBe(EXIT_FAILED);
    expect(seen.config).toBeUndefined();
    expect(host.statuses.map((status) => status['status'])).toEqual(['failed']);
    expect(host.statuses[0]!['error']).toContain('missing required launch argument');
  });
});

describe('runSidecar transcript', () => {
  it('records the task, what the agent says, and the outcome, in order', async () => {
    const { runAgent } = scriptedRunner([
      assistantMessage([
        { type: 'text', text: 'I will look at the project first.' },
        { type: 'tool_use', id: 'tu-1', name: 'Bash', input: { command: 'ls' } },
      ]),
      assistantMessage([{ type: 'tool_use', id: 'tu-2', name: 'Write', input: {} }]),
      resultMessage({
        subtype: 'success',
        is_error: false,
        num_turns: 3,
        duration_ms: 24000,
        total_cost_usd: 0.012,
        result: 'Created README.md.',
      }),
    ]);

    const { host } = await run(runAgent);

    const entries = transcriptEntries(host);
    expect(entries.map((entry) => entry['kind'])).toEqual(['task', 'message', 'message', 'result']);
    expect(entries[0]).toMatchObject({ text: 'Add a README', details: {} });
    expect(entries[1]).toMatchObject({
      text: 'I will look at the project first.',
      details: { toolUseIds: ['tu-1'] },
    });
    expect(entries[2]).toMatchObject({ text: '', details: { toolUseIds: ['tu-2'] } });
    expect(entries[3]).toMatchObject({
      text: 'Created README.md.',
      details: { isError: false, numTurns: 3, durationMs: 24000, totalCostUsd: 0.012 },
    });
    // The sidecar never names a session; Rust files entries under its own.
    expect(entries.every((entry) => !('sessionId' in entry))).toBe(true);
    expect(entries.every((entry) => !Number.isNaN(Date.parse(String(entry['timestamp']))))).toBe(
      true,
    );
  });

  it('stores the outcome before it reports the run finished', async () => {
    const order: string[] = [];
    const host = createFakeBridgeHost((request) => {
      order.push(request.method);
      return { ok: true, result: null };
    });
    const { runAgent } = scriptedRunner([SUCCESS]);

    await runSidecar({ argv: LAUNCH_ARGV, input: host.input, output: host.output, runAgent });
    await expect.poll(() => host.statuses.at(-1)?.['status']).toBe('completed');

    // Both appends were answered while only `started` had been reported.
    expect(order).toEqual(['transcript.append', 'transcript.append']);
    expect(transcriptEntries(host).at(-1)).toMatchObject({ kind: 'result', text: 'ok' });
  });

  it('records a failed run with its error as the outcome', async () => {
    const runAgent: AgentRunner = async function* () {
      yield assistantMessage([{ type: 'text', text: 'Starting.' }]);
      throw new Error('could not reach the model');
    };

    const { host, exitCode } = await run(runAgent);

    expect(exitCode).toBe(EXIT_FAILED);
    const entries = transcriptEntries(host);
    expect(entries.map((entry) => entry['kind'])).toEqual(['task', 'message', 'result']);
    expect(entries[2]).toMatchObject({
      text: 'could not reach the model',
      details: { isError: true },
    });
    // A run that threw has no SDK accounting to report.
    expect(entries[2]!['details']).not.toHaveProperty('numTurns');
  });

  it('completes the run even when the transcript cannot be stored', async () => {
    const diagnostics = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const handler: FakeHandler = (request) =>
      request.method === 'transcript.append'
        ? { ok: false, code: 'store_error', message: 'disk full' }
        : { ok: true, result: null };
    const { runAgent } = scriptedRunner([
      assistantMessage([{ type: 'text', text: 'Working.' }]),
      SUCCESS,
    ]);

    const { host, exitCode } = await run(runAgent, LAUNCH_ARGV, handler);

    expect(exitCode).toBe(EXIT_COMPLETED);
    expect(host.statuses.at(-1)).toMatchObject({ status: 'completed' });
    expect(diagnostics).toHaveBeenCalledWith(expect.stringContaining('disk full'));
    diagnostics.mockRestore();
  });

  it('records nothing for a launch that was refused', async () => {
    const { runAgent } = scriptedRunner([SUCCESS]);

    const { host } = await run(runAgent, ['--session', 'session-1']);

    expect(transcriptEntries(host)).toEqual([]);
  });
});
