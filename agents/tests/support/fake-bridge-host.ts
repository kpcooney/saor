/**
 * agents/tests/support/fake-bridge-host.ts
 *
 * A stand-in for the Rust end of the storage bridge, for tests of the
 * TypeScript end. It owns the two in-memory streams a bridge client talks
 * over, records every line the client writes, and answers each request with
 * whatever the test's handler returns. Like the Rust host, it ends a line at
 * `\n` only.
 *
 * It is a scripted double, not a store: tests that need real store behavior
 * drive the real Rust host from src-tauri/tests/storage_bridge.rs instead.
 */

import { PassThrough } from 'node:stream';

import { readLines } from '../../src/bridge/line-reader.js';
import type { BridgeErrorCode, BridgeMethod } from '../../src/bridge/protocol.js';

/** A request line as the fake host received it. */
export interface RecordedRequest {
  readonly id: number;
  readonly method: BridgeMethod;
  readonly params: unknown;
}

/** What a handler answers: a result, or a refusal. */
export type FakeReply =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly code: BridgeErrorCode; readonly message: string };

/** Decides the reply to a request. Return `undefined` to leave it unanswered. */
export type FakeHandler = (request: RecordedRequest) => FakeReply | undefined;

export interface FakeBridgeHost {
  /** The client's response channel (its stdin). */
  readonly input: PassThrough;
  /** The client's request channel (its stdout). */
  readonly output: PassThrough;
  /** Every request received, in order. */
  readonly requests: RecordedRequest[];
  /** Every status line received, in order. */
  readonly statuses: Record<string, unknown>[];
  /** Write a raw line to the client's response channel. */
  sendRaw(line: string): void;
  /** End the response channel, as if the parent process went away. */
  hangUp(): void;
}

/** Answers every request with a `null` result. */
export const replyNull: FakeHandler = () => ({ ok: true, result: null });

export function createFakeBridgeHost(handler: FakeHandler = replyNull): FakeBridgeHost {
  const input = new PassThrough();
  const output = new PassThrough();
  const requests: RecordedRequest[] = [];
  const statuses: Record<string, unknown>[] = [];

  function sendRaw(line: string): void {
    input.write(`${line}\n`);
  }

  function handleLine(line: string): void {
    const message = JSON.parse(line) as Record<string, unknown>;
    if (message['kind'] === 'status') {
      statuses.push(message);
      return;
    }
    const request: RecordedRequest = {
      id: message['id'] as number,
      method: message['method'] as BridgeMethod,
      params: message['params'],
    };
    requests.push(request);

    const reply = handler(request);
    if (reply === undefined) {
      return;
    }
    if (reply.ok) {
      sendRaw(JSON.stringify({ kind: 'response', id: request.id, ok: true, result: reply.result }));
      return;
    }
    sendRaw(
      JSON.stringify({
        kind: 'response',
        id: request.id,
        ok: false,
        error: { code: reply.code, message: reply.message },
      }),
    );
  }

  readLines(output, { onLine: handleLine, onClose: () => undefined });

  return { input, output, requests, statuses, sendRaw, hangUp: () => input.end() };
}
