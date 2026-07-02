/**
 * agents/tests/mcp/reference-resolver.test.ts
 *
 * Unit tests for the reference-resolver MCP server. The `resolve_ref` tool is
 * tested through its pure handler (resolveReference) against a recording fake
 * ReferenceResolver — no live SDK session and no real backend, per the testing
 * standard for MCP server tools (mock the resolver; verify the URI is forwarded
 * and the result is shaped correctly).
 */

import { describe, expect, it } from 'vitest';

import {
  createReferenceResolverMcpServer,
  parseScheme,
  resolveReference,
} from '../../src/mcp/reference-resolver.js';
import type { ReferenceResolver, ResolvedReference } from '../../src/mcp/reference-resolver.js';

/** Recording fake resolver. Captures calls and returns a canned result or throws. */
class FakeReferenceResolver implements ReferenceResolver {
  calls: string[] = [];
  result: ResolvedReference = { kind: 'content', uri: 'file:///x', content: '' };
  error?: Error;

  async resolve(uri: string): Promise<ResolvedReference> {
    this.calls.push(uri);
    if (this.error) throw this.error;
    return this.result;
  }
}

function payload(result: { content: { type: 'text'; text: string }[] }): unknown {
  return JSON.parse(result.content[0]!.text);
}

describe('parseScheme', () => {
  it('extracts and lowercases the scheme', () => {
    expect(parseScheme('file:///docs/x.md')).toBe('file');
    expect(parseScheme('STANDARDS://coding-standards/typescript')).toBe('standards');
    expect(parseScheme('memory://learning/auth')).toBe('memory');
  });

  it('returns undefined for a string without a scheme://', () => {
    expect(parseScheme('/docs/x.md')).toBeUndefined();
    expect(parseScheme('not a uri')).toBeUndefined();
    expect(parseScheme('file:/missing-slashes')).toBeUndefined();
    expect(parseScheme('')).toBeUndefined();
  });
});

describe('resolveReference', () => {
  it('forwards the URI to the resolver and returns content', async () => {
    const resolver = new FakeReferenceResolver();
    resolver.result = {
      kind: 'content',
      uri: 'file:///docs/adr/007.md',
      content: '# ADR 007',
    };

    const result = await resolveReference(resolver, { uri: 'file:///docs/adr/007.md' });

    expect(resolver.calls).toEqual(['file:///docs/adr/007.md']);
    expect(payload(result)).toEqual({
      kind: 'content',
      uri: 'file:///docs/adr/007.md',
      content: '# ADR 007',
    });
    expect(result.isError).toBeUndefined();
  });

  it('returns memory entries for a memory:// reference', async () => {
    const resolver = new FakeReferenceResolver();
    resolver.result = {
      kind: 'memory',
      uri: 'memory://learning/auth',
      entries: [{ id: 'e1' }, { id: 'e2' }],
    };

    const result = await resolveReference(resolver, { uri: 'memory://learning/auth' });
    const parsed = payload(result) as { kind: string; entries: unknown[] };

    expect(parsed.kind).toBe('memory');
    expect(parsed.entries).toHaveLength(2);
  });

  it('rejects a malformed URI without calling the resolver', async () => {
    const resolver = new FakeReferenceResolver();

    const result = await resolveReference(resolver, { uri: '/not/a/uri' });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('not a valid reference URI');
    expect(resolver.calls).toHaveLength(0);
  });

  it('returns an error result when the resolver throws (e.g. unknown scheme)', async () => {
    const resolver = new FakeReferenceResolver();
    resolver.error = new Error('unknown scheme: tracker://');

    const result = await resolveReference(resolver, { uri: 'tracker://issue/8' });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('resolve_ref failed');
    expect(result.content[0]!.text).toContain('unknown scheme');
    // The tool still delegates — scheme support is the resolver's call.
    expect(resolver.calls).toEqual(['tracker://issue/8']);
  });
});

describe('createReferenceResolverMcpServer', () => {
  it('produces an sdk MCP server config named "reference-resolver"', () => {
    const resolver = new FakeReferenceResolver();
    const server = createReferenceResolverMcpServer({ resolver });

    expect(server.type).toBe('sdk');
    expect(server.name).toBe('reference-resolver');
    expect(server.instance).toBeDefined();
  });
});
