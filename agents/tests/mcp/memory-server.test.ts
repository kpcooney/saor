/**
 * agents/tests/mcp/memory-server.test.ts
 *
 * Unit tests for the memory MCP server. The tools are tested through their pure
 * handlers (memoryRead / memoryWrite / memoryContext) against a recording fake
 * MemoryStore — no live SDK session and no real backend, per the testing
 * standard for MCP server tools (mock the store; verify the call is forwarded
 * and the result is shaped correctly).
 */

import { describe, expect, it } from 'vitest';

import {
  createMemoryMcpServer,
  memoryContext,
  memoryRead,
  memoryToolContextFromIdentity,
  memoryWrite,
  DEFAULT_MEMORY_READ_LIMIT,
  MAX_MEMORY_READ_LIMIT,
} from '../../src/mcp/memory-server.js';
import type {
  KeywordSearchOptions,
  MemoryCategory,
  MemoryEntry,
  MemoryStore,
  MemoryToolContext,
  ProjectContext,
} from '../../src/mcp/memory-server.js';
import { createAgentIdentity } from '../../src/identity/factory.js';

const NOW = new Date('2026-06-01T12:00:00.000Z');

function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: 'entry-1',
    projectId: 'proj-1',
    category: 'learning',
    content: 'content',
    metadata: {},
    createdBy: 'agent:seed',
    createdAt: NOW.toISOString(),
    weight: 1,
    ...overrides,
  };
}

/** Recording fake store. Captures calls and returns canned results. */
class FakeMemoryStore implements MemoryStore {
  searchCalls: { query: string; options?: KeywordSearchOptions }[] = [];
  written: MemoryEntry[] = [];
  searchResults: readonly MemoryEntry[] = [];
  projectContext: ProjectContext = {
    projectId: 'proj-1',
    recentLearnings: [],
    conventions: [],
  };
  failOn?: 'search' | 'write' | 'context';

  async keywordSearch(
    query: string,
    options?: KeywordSearchOptions,
  ): Promise<readonly MemoryEntry[]> {
    this.searchCalls.push({ query, options });
    if (this.failOn === 'search') throw new Error('store search boom');
    return this.searchResults;
  }

  async write(entry: MemoryEntry): Promise<void> {
    if (this.failOn === 'write') throw new Error('store write boom');
    this.written.push(entry);
  }

  async getProjectContext(projectId: string): Promise<ProjectContext> {
    if (this.failOn === 'context') throw new Error('store context boom');
    return { ...this.projectContext, projectId };
  }
}

function contextWith(
  overrides: Partial<MemoryToolContext> = {},
): MemoryToolContext {
  return {
    projectId: 'proj-1',
    agentId: 'agent:code:test',
    readableCategories: ['learning', 'context'],
    writableCategories: ['learning'],
    ...overrides,
  };
}

/** Parse the JSON payload out of a successful tool result. */
function payload(result: { content: { type: 'text'; text: string }[] }): unknown {
  return JSON.parse(result.content[0]!.text);
}

describe('memoryRead', () => {
  it('forwards the query, category, and limit to the store', async () => {
    const store = new FakeMemoryStore();
    await memoryRead(store, contextWith(), { query: 'auth', category: 'learning', limit: 5 });

    expect(store.searchCalls).toEqual([
      { query: 'auth', options: { category: 'learning', limit: 5 } },
    ]);
  });

  it('applies the default limit and omits category when not given', async () => {
    const store = new FakeMemoryStore();
    await memoryRead(store, contextWith(), { query: 'x' });

    expect(store.searchCalls[0]).toEqual({
      query: 'x',
      options: { limit: DEFAULT_MEMORY_READ_LIMIT },
    });
  });

  it('clamps an over-large limit to the maximum', async () => {
    const store = new FakeMemoryStore();
    await memoryRead(store, contextWith(), { query: 'x', limit: 10_000 });

    expect(store.searchCalls[0]?.options?.limit).toBe(MAX_MEMORY_READ_LIMIT);
  });

  it('filters results to the agent\'s readable categories', async () => {
    const store = new FakeMemoryStore();
    store.searchResults = [
      makeEntry({ id: 'a', category: 'learning' }),
      makeEntry({ id: 'b', category: 'convention' }), // not readable
      makeEntry({ id: 'c', category: 'context' }),
    ];

    const result = await memoryRead(store, contextWith(), { query: 'x' });
    const { results } = payload(result) as { results: MemoryEntry[] };

    expect(results.map((e) => e.id)).toEqual(['a', 'c']);
  });

  it('denies a read of a category the agent may not read, without hitting the store', async () => {
    const store = new FakeMemoryStore();
    const result = await memoryRead(store, contextWith(), {
      query: 'x',
      category: 'convention',
    });

    expect(result.isError).toBe(true);
    expect(store.searchCalls).toHaveLength(0);
  });

  it('returns an error result when the store search throws', async () => {
    const store = new FakeMemoryStore();
    store.failOn = 'search';

    const result = await memoryRead(store, contextWith(), { query: 'x' });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('memory_read failed');
  });
});

describe('memoryWrite', () => {
  const deps = { now: () => NOW, generateId: () => 'generated-id' };

  it('stamps the system fields and persists the entry', async () => {
    const store = new FakeMemoryStore();
    const result = await memoryWrite(
      store,
      contextWith(),
      { category: 'learning', content: 'the auth flow uses PKCE', metadata: { issue: '8' } },
      deps,
    );

    expect(store.written).toEqual([
      {
        id: 'generated-id',
        projectId: 'proj-1',
        category: 'learning',
        content: 'the auth flow uses PKCE',
        metadata: { issue: '8' },
        createdBy: 'agent:code:test',
        createdAt: NOW.toISOString(),
        weight: 1,
      },
    ]);
    expect(payload(result)).toEqual({
      id: 'generated-id',
      category: 'learning',
      createdAt: NOW.toISOString(),
    });
  });

  it('defaults metadata to an empty object', async () => {
    const store = new FakeMemoryStore();
    await memoryWrite(store, contextWith(), { category: 'learning', content: 'c' }, deps);

    expect(store.written[0]?.metadata).toEqual({});
  });

  it('denies a write to a category the agent may not write, without hitting the store', async () => {
    const store = new FakeMemoryStore();
    const result = await memoryWrite(
      store,
      contextWith(),
      { category: 'context', content: 'c' }, // context is readable but not writable
      deps,
    );

    expect(result.isError).toBe(true);
    expect(store.written).toHaveLength(0);
  });

  it('returns an error result when the store write throws', async () => {
    const store = new FakeMemoryStore();
    store.failOn = 'write';

    const result = await memoryWrite(
      store,
      contextWith(),
      { category: 'learning', content: 'c' },
      deps,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('memory_write failed');
  });
});

describe('memoryContext', () => {
  it('returns the project context filtered to readable categories', async () => {
    const store = new FakeMemoryStore();
    store.projectContext = {
      projectId: 'proj-1',
      recentLearnings: [
        makeEntry({ id: 'l1', category: 'learning' }),
        makeEntry({ id: 'x1', category: 'convention' }), // not readable
      ],
      conventions: [
        makeEntry({ id: 'c1', category: 'context' }),
        makeEntry({ id: 'x2', category: 'convention' }), // not readable
      ],
    };

    const result = await memoryContext(store, contextWith());
    const ctx = payload(result) as ProjectContext;

    expect(ctx.recentLearnings.map((e) => e.id)).toEqual(['l1']);
    expect(ctx.conventions.map((e) => e.id)).toEqual(['c1']);
  });

  it('returns an error result when the store throws', async () => {
    const store = new FakeMemoryStore();
    store.failOn = 'context';

    const result = await memoryContext(store, contextWith());

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('memory_context failed');
  });
});

describe('memoryToolContextFromIdentity', () => {
  it('derives the read/write namespaces from the identity scope', () => {
    const identity = createAgentIdentity(
      {
        id: 'agent:code:test',
        type: 'specialist',
        role: 'code-agent',
        delegatedBy: 'human:kevin',
        purpose: 'test',
        scope: {
          issues: ['8'],
          files: ['agents/src/**'],
          branches: ['main'],
          tools: ['Read'],
          memoryNamespaces: { read: ['learning', 'context'], write: ['learning'] },
        },
        expiresAt: '2999-01-01T00:00:00.000Z',
      },
      { now: NOW },
    );

    const ctx = memoryToolContextFromIdentity(identity, 'proj-1');

    expect(ctx).toEqual({
      projectId: 'proj-1',
      agentId: 'agent:code:test',
      readableCategories: ['learning', 'context'],
      writableCategories: ['learning'],
    });
  });
});

describe('createMemoryMcpServer', () => {
  it('produces an sdk MCP server config named "project-memory"', () => {
    const store = new FakeMemoryStore();
    const server = createMemoryMcpServer({ store, context: contextWith() });

    expect(server.type).toBe('sdk');
    expect(server.name).toBe('project-memory');
    expect(server.instance).toBeDefined();
  });
});

/** Keep the MemoryCategory import meaningful for readers of the fixtures above. */
const _categories: readonly MemoryCategory[] = ['learning', 'convention', 'context', 'index'];
void _categories;
