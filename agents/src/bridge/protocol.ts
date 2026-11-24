/**
 * agents/src/bridge/protocol.ts
 *
 * Wire types for the Node↔Rust storage bridge (issue #59, ADR-009). The agent
 * sidecar is a Node subprocess and cannot call Tauri `invoke`, so it reaches
 * the Rust-owned memory store, audit store, and reference resolver by
 * exchanging line-delimited JSON with the Rust backend over its own stdio:
 * requests and status lines go out on stdout, responses come back on stdin.
 *
 * Every protocol line is one JSON object with a `kind` discriminator. These
 * types mirror src-tauri/src/bridge/protocol.rs and are kept in sync by hand;
 * the cross-process test in src-tauri/tests/storage_bridge.rs fails if the two
 * drift.
 *
 * See docs/adr/009-agent-storage-bridge-transport.md for the transport decision
 * and the full wire format.
 */

/**
 * The storage primitives the Rust side serves. Anything that composes them
 * (for example the `memory_context` summary) is built in the adapters, so no
 * agent logic lives in Rust.
 */
export const BRIDGE_METHODS = {
  /** Keyword-search the project's memory. */
  memorySearch: 'memory.search',
  /** Persist one memory entry. */
  memoryWrite: 'memory.write',
  /** List the most recent entries of one category. */
  memoryRecent: 'memory.recent',
  /** Append one event to the audit trail. */
  auditLog: 'audit.log',
  /** Dereference one reference-manifest URI. */
  referenceResolve: 'reference.resolve',
  /** Append one entry to the session's transcript. */
  transcriptAppend: 'transcript.append',
} as const;

/** A method name the bridge serves. */
export type BridgeMethod = (typeof BRIDGE_METHODS)[keyof typeof BRIDGE_METHODS];

/**
 * Why a bridge request failed. The first six are reported by the Rust side
 * (`BridgeErrorCode` in protocol.rs); the last two are raised locally by the
 * client and adapters.
 */
export type BridgeErrorCode =
  | 'invalid_request'
  | 'unknown_method'
  | 'invalid_params'
  | 'scope_mismatch'
  | 'store_error'
  | 'resolve_error'
  /** The channel closed before a response arrived, or was already closed. */
  | 'bridge_closed'
  /** A successful response did not have the shape the method promises. */
  | 'invalid_response';

/** A request line, written by the sidecar to stdout. */
export interface BridgeRequest {
  readonly kind: 'request';
  /** Correlation id, unique per client; echoed on the response. */
  readonly id: number;
  readonly method: BridgeMethod;
  readonly params: unknown;
}

/** A response line, read by the sidecar from stdin. */
export type BridgeResponse =
  | { readonly kind: 'response'; readonly id: number; readonly ok: true; readonly result: unknown }
  | {
      readonly kind: 'response';
      /** `null` when Rust could not recover an id from a malformed request. */
      readonly id: number | null;
      readonly ok: false;
      readonly error: { readonly code: BridgeErrorCode; readonly message: string };
    };

/** The lifecycle states a sidecar reports about its agent run. */
export type SidecarStatusName = 'started' | 'completed' | 'failed' | 'stopped';

/**
 * A lifecycle status line, written by the sidecar to stdout. `error` carries
 * the failure message on a `failed` status; Rust records it as the reason on
 * the run's `agent.failed` audit event. Other fields are informational.
 */
export interface SidecarStatusLine {
  readonly kind: 'status';
  readonly status: SidecarStatusName;
  readonly error?: string;
  readonly [extra: string]: unknown;
}

/**
 * A failed bridge request. Thrown by the client and adapters so the port
 * implementations reject the way the MCP tools already expect (they turn a
 * rejection into an error result for the agent). `code` lets a caller tell a
 * refused request from a store failure without parsing the message.
 */
export class BridgeRequestError extends Error {
  readonly code: BridgeErrorCode;

  constructor(code: BridgeErrorCode, message: string) {
    super(message);
    this.name = 'BridgeRequestError';
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Narrow a parsed stdin line to a {@link BridgeResponse}. Anything else on
 * stdin is not part of the protocol and is dropped by the client.
 */
export function isBridgeResponse(value: unknown): value is BridgeResponse {
  if (!isRecord(value) || value['kind'] !== 'response') {
    return false;
  }
  if (value['ok'] === true) {
    return typeof value['id'] === 'number';
  }
  if (value['ok'] !== false) {
    return false;
  }
  const error = value['error'];
  const hasValidId = typeof value['id'] === 'number' || value['id'] === null;
  return (
    hasValidId &&
    isRecord(error) &&
    typeof error['code'] === 'string' &&
    typeof error['message'] === 'string'
  );
}
