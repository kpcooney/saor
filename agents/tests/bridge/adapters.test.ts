/**
 * agents/tests/bridge/adapters.test.ts
 *
 * Tests for the bridge-backed port adapters (issue #59): that each port method
 * maps to the right bridge request, that the two pieces of logic living here
 * (project-context composition, audit session restamping) behave, and that a
 * response of the wrong shape is rejected rather than passed on.
 *
 * The bridge client is a recording fake — these verify the mapping. The same
 * adapters are run against the real Rust stores, from a real Node process, by
 * src-tauri/tests/storage_bridge.rs.
 */

import { describe, expect, it } from 'vitest';

import {
  createBridgeAuditLogger,
  createBridgeMemoryStore,
  createBridgeReferenceResolver,
  PROJECT_CONTEXT_LIMIT,
} from '../../src/bridge/adapters.js';
import type { BridgeClient } from '../../src/bridge/client.js';
import { BridgeRequestError, type BridgeMethod } from '../../src/bridge/protocol.js';
import type { AuditEvent } from '../../src/hooks/audit-logger.js';
import type { MemoryEntry } from '../../src/mcp/memory-server.js';

interface RecordedCall {
  readonly method: BridgeMethod;
  readonly params: unknown;
}

/** Records every request and answers from a per-method table. */
class FakeBridgeClient implements BridgeClient {
  readonly calls: RecordedCall[] = [];

  constructor(private readonly reply: (call: RecordedCall) => unknown = () => null) {}

  async request(method: BridgeMethod, params: unknown): Promise<unknown> {
    const call = { method, params };
    this.calls.push(call);
    return this.reply(call);
  }

  sendStatus(): void {}

  close(): void {}
}

function wireEntry(overrides: Partial<Record<keyof MemoryEntry, unknown>> = {}) {
  return {
    id: 'e1',
    projectId: 'proj-1',
    category: 'learning',
    content: 'a learning',
    metadata: { source: 'test' },
    createdBy: 'agent:code-agent:session-1',
    createdAt: '2026-11-23T12:00:00.000Z',
    weight: 1,
    ...overrides,
  };
}

describe('createBridgeMemoryStore', () => {
  it('forwards a keyword search with its options and returns the entries', async () => {
    const client = new FakeBridgeClient(() => [wireEntry()]);
    const store = createBridgeMemoryStore(client);

    const results = await store.keywordSearch('bridge', { category: 'learning', limit: 5 });

    expect(client.calls).toEqual([
      { method: 'memory.search', params: { query: 'bridge', category: 'learning', limit: 5 } },
    ]);
    expect(results).toEqual([wireEntry()]);
  });

  it('omits absent search options rather than sending undefined', async () => {
    const client = new FakeBridgeClient(() => []);

    await createBridgeMemoryStore(client).keywordSearch('bridge');

    expect(client.calls[0]!.params).toEqual({ query: 'bridge' });
  });

  it('normalizes null metadata from the store to an empty object', async () => {
    const client = new FakeBridgeClient(() => [wireEntry({ metadata: null })]);

    const results = await createBridgeMemoryStore(client).keywordSearch('bridge');

    expect(results[0]!.metadata).toEqual({});
  });

  it('forwards a write as the entry itself', async () => {
    const client = new FakeBridgeClient();
    const entry = wireEntry() as MemoryEntry;

    await createBridgeMemoryStore(client).write(entry);

    expect(client.calls).toEqual([{ method: 'memory.write', params: { entry } }]);
  });

  it('composes project context from recent learnings and conventions', async () => {
    const learning = wireEntry({ id: 'l1' });
    const convention = wireEntry({ id: 'c1', category: 'convention' });
    const foreign = wireEntry({ id: 'x1', projectId: 'another-project' });
    const client = new FakeBridgeClient((call) => {
      const { category } = call.params as { category: string };
      return category === 'learning' ? [learning, foreign] : [convention];
    });

    const context = await createBridgeMemoryStore(client).getProjectContext('proj-1');

    expect(client.calls).toEqual([
      { method: 'memory.recent', params: { category: 'learning', limit: PROJECT_CONTEXT_LIMIT } },
      { method: 'memory.recent', params: { category: 'convention', limit: PROJECT_CONTEXT_LIMIT } },
    ]);
    // The entry for another project is filtered out.
    expect(context).toEqual({
      projectId: 'proj-1',
      recentLearnings: [learning],
      conventions: [convention],
    });
  });

  it('rejects a response that is not a list of memory entries', async () => {
    const missingField = { ...wireEntry(), createdBy: undefined };
    for (const bad of [null, { entries: [] }, [missingField], [wireEntry({ category: 'bogus' })]]) {
      const store = createBridgeMemoryStore(new FakeBridgeClient(() => bad));
      await expect(store.keywordSearch('bridge')).rejects.toMatchObject({
        code: 'invalid_response',
      });
    }
  });

  it('propagates a bridge failure to the caller', async () => {
    const client = new FakeBridgeClient(() => {
      throw new BridgeRequestError('store_error', 'fts5: syntax error');
    });

    await expect(createBridgeMemoryStore(client).keywordSearch('"')).rejects.toMatchObject({
      code: 'store_error',
      message: 'fts5: syntax error',
    });
  });
});

describe('createBridgeAuditLogger', () => {
  const event: AuditEvent = {
    id: 'evt-1',
    timestamp: '2026-11-23T12:00:00.000Z',
    projectId: 'proj-1',
    agentId: 'agent:code-agent:session-1',
    agentRole: 'code-agent',
    delegationChain: ['human:local', 'agent:code-agent:session-1'],
    eventType: 'tool.invoked',
    action: 'Write',
    details: { tool: 'Write', toolUseId: 'tu-1' },
    sessionId: 'sdk-session-abc',
    result: 'pending',
  };

  it('restamps the session id and keeps the SDK session id in details', async () => {
    const client = new FakeBridgeClient();
    const logger = createBridgeAuditLogger(client, { sessionId: 'session-1' });

    await logger.log(event);

    expect(client.calls).toEqual([
      {
        method: 'audit.log',
        params: {
          event: {
            ...event,
            sessionId: 'session-1',
            details: { tool: 'Write', toolUseId: 'tu-1', sdkSessionId: 'sdk-session-abc' },
          },
        },
      },
    ]);
    // The caller's event is not mutated.
    expect(event.sessionId).toBe('sdk-session-abc');
    expect(event.details).toEqual({ tool: 'Write', toolUseId: 'tu-1' });
  });

  it('rejects when the bridge refuses the event', async () => {
    const client = new FakeBridgeClient(() => {
      throw new BridgeRequestError('scope_mismatch', 'wrong session');
    });
    const logger = createBridgeAuditLogger(client, { sessionId: 'session-1' });

    await expect(logger.log(event)).rejects.toMatchObject({ code: 'scope_mismatch' });
  });
});

describe('createBridgeReferenceResolver', () => {
  it('forwards the URI and returns content and memory references', async () => {
    const content = { kind: 'content', uri: 'file://docs/x.md', content: 'hello' };
    const memory = { kind: 'memory', uri: 'memory://query/x', entries: [wireEntry()] };
    const client = new FakeBridgeClient((call) =>
      (call.params as { uri: string }).uri.startsWith('file') ? content : memory,
    );
    const resolver = createBridgeReferenceResolver(client);

    await expect(resolver.resolve('file://docs/x.md')).resolves.toEqual(content);
    await expect(resolver.resolve('memory://query/x')).resolves.toEqual(memory);
    expect(client.calls[0]).toEqual({
      method: 'reference.resolve',
      params: { uri: 'file://docs/x.md' },
    });
  });

  it('rejects a response that is not a resolved reference', async () => {
    for (const bad of [null, 'text', { kind: 'content', uri: 'file://x' }, { kind: 'other' }]) {
      const resolver = createBridgeReferenceResolver(new FakeBridgeClient(() => bad));
      await expect(resolver.resolve('file://x')).rejects.toMatchObject({
        code: 'invalid_response',
      });
    }
  });
});
