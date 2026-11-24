/**
 * agents/src/bridge/client.ts
 *
 * The sidecar's end of the storage bridge (ADR-009): a small request/response
 * client over a pair of streams. In production those are the process's own
 * stdout (requests and status lines out) and stdin (responses in); tests pass
 * in-memory streams.
 *
 * Each request is one JSON line carrying a numeric id. A line ends at `\n`
 * and nothing else — see line-reader.ts for why that matters. Responses are
 * matched to their request by that id, so several requests can be in flight at
 * once — the audit hooks and a memory tool may well overlap.
 *
 * Failure handling, in order of how it can go wrong:
 *
 *   - Rust answers `ok: false` → the request rejects with a
 *     {@link BridgeRequestError} carrying Rust's code and message.
 *   - The input stream ends (the parent died or closed the pipe) → every
 *     in-flight request rejects with `bridge_closed`, and later requests reject
 *     immediately, so a dead parent cannot hang the agent.
 *   - A line arrives that is not a response this client is waiting for → it is
 *     reported through `onDiagnostic` and dropped. Nothing on stdin can crash
 *     the client.
 */

import type { Readable, Writable } from 'node:stream';

import { readLines } from './line-reader.js';
import {
  BridgeRequestError,
  isBridgeResponse,
  type BridgeMethod,
  type BridgeRequest,
  type SidecarStatusLine,
  type SidecarStatusName,
} from './protocol.js';

/** The request/response channel the bridge adapters are written against. */
export interface BridgeClient {
  /**
   * Send one request and resolve with its `result`. Rejects with a
   * {@link BridgeRequestError} if Rust refuses it or the channel closes first.
   */
  request(method: BridgeMethod, params: unknown): Promise<unknown>;
  /** Report a lifecycle status to the Rust side. Fire-and-forget. */
  sendStatus(status: SidecarStatusName, extra?: Record<string, unknown>): void;
  /**
   * Stop reading and fail any in-flight requests. Idempotent. Call it when the
   * agent run ends so the input stream no longer holds the process open.
   */
  close(): void;
}

/** The stream pair a {@link BridgeClient} talks over. */
export interface BridgeStreams {
  /** Where response lines arrive (the sidecar's stdin). */
  readonly input: Readable;
  /** Where request and status lines are written (the sidecar's stdout). */
  readonly output: Writable;
}

/** Optional behavior for {@link createBridgeClient}. */
export interface BridgeClientOptions {
  /**
   * Receives a note about each dropped line. Defaults to stderr — stdout is the
   * protocol channel, so diagnostics must never go there.
   */
  readonly onDiagnostic?: (message: string) => void;
}

/** The two halves of a request's promise, held until its response arrives. */
interface PendingRequest {
  readonly method: BridgeMethod;
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: BridgeRequestError) => void;
}

function reportToStderr(message: string): void {
  console.error(`storage-bridge: ${message}`);
}

/** Create a {@link BridgeClient} over the given streams. */
export function createBridgeClient(
  streams: BridgeStreams,
  options: BridgeClientOptions = {},
): BridgeClient {
  const onDiagnostic = options.onDiagnostic ?? reportToStderr;
  const pending = new Map<number, PendingRequest>();
  let nextId = 1;
  let isClosed = false;

  function writeLine(message: BridgeRequest | SidecarStatusLine): void {
    streams.output.write(`${JSON.stringify(message)}\n`);
  }

  function failAllPending(reason: string): void {
    for (const [id, request] of pending) {
      pending.delete(id);
      request.reject(
        new BridgeRequestError('bridge_closed', `${request.method} failed: ${reason}`),
      );
    }
  }

  /** Remove and return the request awaiting `id`, reporting an unknown id. */
  function takePending(id: number): PendingRequest | undefined {
    const request = pending.get(id);
    if (request === undefined) {
      onDiagnostic(`dropped a response for unknown request id ${id}`);
      return undefined;
    }
    pending.delete(id);
    return request;
  }

  function handleLine(line: string): void {
    if (line.trim().length === 0) {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      onDiagnostic('dropped a line on the response channel that is not JSON');
      return;
    }
    if (!isBridgeResponse(parsed)) {
      onDiagnostic('dropped a line on the response channel that is not a bridge response');
      return;
    }

    if (parsed.ok) {
      takePending(parsed.id)?.resolve(parsed.result);
      return;
    }
    const error = new BridgeRequestError(parsed.error.code, parsed.error.message);
    if (parsed.id === null) {
      // Rust could not tell which request this answers, so neither can we.
      onDiagnostic(`uncorrelated bridge error: ${error.message}`);
      return;
    }
    takePending(parsed.id)?.reject(error);
  }

  const lines = readLines(streams.input, {
    onLine: handleLine,
    // Called when the input ends on its own (the parent went away) as well as
    // after our own close(); either way nothing more will be answered.
    onClose: () => {
      isClosed = true;
      failAllPending('the storage bridge closed before a response arrived');
    },
  });

  return {
    request(method: BridgeMethod, params: unknown): Promise<unknown> {
      if (isClosed) {
        return Promise.reject(
          new BridgeRequestError('bridge_closed', `${method} failed: the storage bridge is closed`),
        );
      }
      const id = nextId;
      nextId += 1;
      return new Promise<unknown>((resolve, reject) => {
        pending.set(id, { method, resolve, reject });
        writeLine({ kind: 'request', id, method, params });
      });
    },

    sendStatus(status: SidecarStatusName, extra: Record<string, unknown> = {}): void {
      writeLine({ ...extra, kind: 'status', status });
    },

    close(): void {
      if (isClosed) {
        return;
      }
      // Also pauses the input, so an open stdin pipe does not keep the
      // process alive.
      lines.close();
    },
  };
}
