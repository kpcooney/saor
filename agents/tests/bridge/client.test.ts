/**
 * agents/tests/bridge/client.test.ts
 *
 * Tests for the storage-bridge client (issue #59, ADR-009): request/response
 * correlation over a stream pair, error mapping, and — the part that matters
 * most for a channel shared with stdout/stdin — that nothing arriving on the
 * response channel can crash it or hang a caller.
 *
 * The Rust end is played by a scripted fake host over in-memory streams. The
 * real Rust host is exercised against this same client from
 * src-tauri/tests/storage_bridge.rs.
 */

import { describe, expect, it } from 'vitest';

import { createBridgeClient } from '../../src/bridge/client.js';
import { BRIDGE_METHODS, BridgeRequestError } from '../../src/bridge/protocol.js';
import { createFakeBridgeHost, type FakeHandler } from '../support/fake-bridge-host.js';

function connect(handler?: FakeHandler) {
  const host = createFakeBridgeHost(handler);
  const diagnostics: string[] = [];
  const client = createBridgeClient(
    { input: host.input, output: host.output },
    { onDiagnostic: (message) => diagnostics.push(message) },
  );
  return { host, client, diagnostics };
}

describe('createBridgeClient', () => {
  it('writes a request line and resolves with the matching result', async () => {
    const { host, client } = connect((request) => ({
      ok: true,
      result: { echoed: request.params },
    }));

    const result = await client.request(BRIDGE_METHODS.memorySearch, { query: 'bridge' });

    expect(result).toEqual({ echoed: { query: 'bridge' } });
    expect(host.requests).toEqual([
      { id: 1, method: 'memory.search', params: { query: 'bridge' } },
    ]);
  });

  it('correlates concurrent requests by id even when answered out of order', async () => {
    // Leave every request unanswered, then reply by hand in reverse order.
    const { host, client } = connect(() => undefined);

    const first = client.request(BRIDGE_METHODS.memoryRecent, { category: 'learning' });
    const second = client.request(BRIDGE_METHODS.memoryRecent, { category: 'convention' });
    await expect.poll(() => host.requests.length).toBe(2);

    const [firstRequest, secondRequest] = host.requests;
    expect(firstRequest!.id).not.toBe(secondRequest!.id);
    host.sendRaw(
      JSON.stringify({ kind: 'response', id: secondRequest!.id, ok: true, result: 'second' }),
    );
    host.sendRaw(
      JSON.stringify({ kind: 'response', id: firstRequest!.id, ok: true, result: 'first' }),
    );

    await expect(first).resolves.toBe('first');
    await expect(second).resolves.toBe('second');
  });

  it('rejects with the code and message Rust reports', async () => {
    const { client } = connect(() => ({
      ok: false,
      code: 'scope_mismatch',
      message: 'request names project "other"',
    }));

    const failure = client.request(BRIDGE_METHODS.memoryWrite, { entry: {} });

    await expect(failure).rejects.toBeInstanceOf(BridgeRequestError);
    await expect(failure).rejects.toMatchObject({
      code: 'scope_mismatch',
      message: 'request names project "other"',
    });
  });

  it('drops noise on the response channel and still answers the request', async () => {
    const { host, client, diagnostics } = connect(() => undefined);

    const pending = client.request(BRIDGE_METHODS.auditLog, { event: {} });
    await expect.poll(() => host.requests.length).toBe(1);

    host.sendRaw('not json at all');
    host.sendRaw('{"kind":"something-else"}');
    host.sendRaw('{"kind":"response","id":999,"ok":true,"result":null}');
    host.sendRaw(
      '{"kind":"response","id":null,"ok":false,"error":{"code":"invalid_request","message":"no id"}}',
    );
    host.sendRaw('');
    host.sendRaw('{"kind":"response","id":1,"ok":true,"result":"answered"}');

    await expect(pending).resolves.toBe('answered');
    // Each dropped line was reported (the blank line is silently skipped).
    expect(diagnostics).toHaveLength(4);
    expect(diagnostics.join('\n')).toContain('unknown request id 999');
    expect(diagnostics.join('\n')).toContain('uncorrelated bridge error: no id');
  });

  it('fails in-flight requests when the response channel ends', async () => {
    const { host, client } = connect(() => undefined);

    const pending = client.request(BRIDGE_METHODS.memorySearch, { query: 'x' });
    await expect.poll(() => host.requests.length).toBe(1);
    host.hangUp();

    await expect(pending).rejects.toMatchObject({ code: 'bridge_closed' });
    // And a request made afterwards fails immediately rather than hanging.
    await expect(
      client.request(BRIDGE_METHODS.memorySearch, { query: 'y' }),
    ).rejects.toMatchObject({ code: 'bridge_closed' });
    expect(host.requests).toHaveLength(1);
  });

  it('close() fails in-flight requests and is idempotent', async () => {
    const { host, client } = connect(() => undefined);

    const pending = client.request(BRIDGE_METHODS.memorySearch, { query: 'x' });
    await expect.poll(() => host.requests.length).toBe(1);
    client.close();
    client.close();

    await expect(pending).rejects.toMatchObject({ code: 'bridge_closed' });
  });

  it('sends status lines tagged with kind and status', async () => {
    const { host, client } = connect();

    client.sendStatus('failed', { session: 'session-1', error: 'boom' });

    await expect.poll(() => host.statuses.length).toBe(1);
    expect(host.statuses[0]).toEqual({
      kind: 'status',
      status: 'failed',
      session: 'session-1',
      error: 'boom',
    });
  });
});
