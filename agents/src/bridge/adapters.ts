/**
 * agents/src/bridge/adapters.ts
 *
 * The concrete implementations of the agent layer's storage ports —
 * {@link MemoryStore}, {@link AuditLogger}, {@link ReferenceResolver}, and
 * {@link TranscriptRecorder} — backed by the Rust stores through the storage
 * bridge (ADR-009). These are the
 * "IPC-backed adapters" the MCP servers and hooks were written against; with
 * them a launched agent reads and writes the same memory database and audit
 * trail the UI shows.
 *
 * Each adapter is a thin mapping from a port method to one or two bridge
 * requests. Two things happen here rather than in Rust, because they are agent
 * concerns and the Rust layer serves storage primitives only:
 *
 *   - `getProjectContext` composes the orientation summary from two
 *     `memory.recent` calls.
 *   - The audit logger restamps each event's `sessionId` with the Saor session
 *     id (see {@link createBridgeAuditLogger}).
 *
 * Successful responses are checked with type guards before they are returned,
 * so a wire-format drift between the two sides surfaces as a clear
 * `invalid_response` error rather than as a malformed object deeper in a tool.
 */

import type { AuditEvent, AuditLogger } from '../hooks/audit-logger.js';
import type {
  KeywordSearchOptions,
  MemoryCategory,
  MemoryEntry,
  MemoryStore,
  ProjectContext,
} from '../mcp/memory-server.js';
import type { ReferenceResolver, ResolvedReference } from '../mcp/reference-resolver.js';
import type { TranscriptEntry, TranscriptRecorder } from '../transcript/entries.js';

import type { BridgeClient } from './client.js';
import { BRIDGE_METHODS, BridgeRequestError, type BridgeMethod } from './protocol.js';

/**
 * How many recent learnings and conventions `getProjectContext` returns each.
 * Enough to orient an agent without flooding its context.
 */
export const PROJECT_CONTEXT_LIMIT = 10;

const MEMORY_CATEGORIES: readonly string[] = ['learning', 'convention', 'context', 'index'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A memory entry as Rust sends it. Identical to {@link MemoryEntry} except that
 * `metadata` may be `null`: entries written from the UI without metadata are
 * stored that way.
 */
interface WireMemoryEntry extends Omit<MemoryEntry, 'metadata'> {
  readonly metadata: Record<string, unknown> | null;
}

function isWireMemoryEntry(value: unknown): value is WireMemoryEntry {
  return (
    isRecord(value) &&
    typeof value['id'] === 'string' &&
    typeof value['projectId'] === 'string' &&
    typeof value['category'] === 'string' &&
    MEMORY_CATEGORIES.includes(value['category']) &&
    typeof value['content'] === 'string' &&
    (value['metadata'] === null || isRecord(value['metadata'])) &&
    typeof value['createdBy'] === 'string' &&
    typeof value['createdAt'] === 'string' &&
    typeof value['weight'] === 'number'
  );
}

function isWireMemoryEntryArray(value: unknown): value is WireMemoryEntry[] {
  return Array.isArray(value) && value.every(isWireMemoryEntry);
}

function isResolvedReference(value: unknown): value is ResolvedReference {
  if (!isRecord(value) || typeof value['uri'] !== 'string') {
    return false;
  }
  if (value['kind'] === 'content') {
    return typeof value['content'] === 'string';
  }
  return value['kind'] === 'memory' && Array.isArray(value['entries']);
}

function invalidResponse(method: BridgeMethod): BridgeRequestError {
  return new BridgeRequestError(
    'invalid_response',
    `${method} returned a result that does not match the bridge protocol`,
  );
}

/** Normalize a wire entry to the port's shape: absent metadata becomes `{}`. */
function toMemoryEntry(entry: WireMemoryEntry): MemoryEntry {
  return { ...entry, metadata: entry.metadata ?? {} };
}

/** Request a list of memory entries and validate the response. */
async function requestEntries(
  client: BridgeClient,
  method: BridgeMethod,
  params: unknown,
): Promise<readonly MemoryEntry[]> {
  const result = await client.request(method, params);
  if (!isWireMemoryEntryArray(result)) {
    throw invalidResponse(method);
  }
  return result.map(toMemoryEntry);
}

/**
 * A {@link MemoryStore} backed by the project's Rust SQLite memory store.
 *
 * The Rust side is bound to one project, so every entry it returns belongs to
 * that project and a write for any other project is refused there.
 */
export function createBridgeMemoryStore(client: BridgeClient): MemoryStore {
  function recent(category: MemoryCategory): Promise<readonly MemoryEntry[]> {
    return requestEntries(client, BRIDGE_METHODS.memoryRecent, {
      category,
      limit: PROJECT_CONTEXT_LIMIT,
    });
  }

  return {
    keywordSearch(
      query: string,
      options: KeywordSearchOptions = {},
    ): Promise<readonly MemoryEntry[]> {
      return requestEntries(client, BRIDGE_METHODS.memorySearch, {
        query,
        ...(options.category !== undefined ? { category: options.category } : {}),
        ...(options.limit !== undefined ? { limit: options.limit } : {}),
      });
    },

    async write(entry: MemoryEntry): Promise<void> {
      await client.request(BRIDGE_METHODS.memoryWrite, { entry });
    },

    async getProjectContext(projectId: string): Promise<ProjectContext> {
      const [recentLearnings, conventions] = await Promise.all([
        recent('learning'),
        recent('convention'),
      ]);
      // The store only holds the bound project's entries; the filter makes the
      // port's "for this project" contract hold even if asked about another.
      const isForProject = (entry: MemoryEntry): boolean => entry.projectId === projectId;
      return {
        projectId,
        recentLearnings: recentLearnings.filter(isForProject),
        conventions: conventions.filter(isForProject),
      };
    },
  };
}

/** Configuration for {@link createBridgeAuditLogger}. */
export interface BridgeAuditLoggerConfig {
  /**
   * The Saor session id the process manager assigned to this agent run (the
   * sidecar's `--session` argument).
   */
  readonly sessionId: string;
}

/**
 * An {@link AuditLogger} backed by the project's Rust JSONL audit store.
 *
 * The audit hooks stamp each event with the Claude SDK's session id, which is
 * what they are handed. The rest of the system groups a run by the *Saor*
 * session id: it is what the process manager tracks, what Rust stamps on the
 * `agent.created` / `agent.completed` lifecycle events, and what the Rust side
 * of the bridge requires (it refuses events for any other session). So this
 * adapter restamps `sessionId` with the Saor id and keeps the SDK's id as
 * `details.sdkSessionId`, where it still ties the event to the SDK transcript.
 */
export function createBridgeAuditLogger(
  client: BridgeClient,
  config: BridgeAuditLoggerConfig,
): AuditLogger {
  return {
    async log(event: AuditEvent): Promise<void> {
      const bridged: AuditEvent = {
        ...event,
        sessionId: config.sessionId,
        details: { ...event.details, sdkSessionId: event.sessionId },
      };
      await client.request(BRIDGE_METHODS.auditLog, { event: bridged });
    },
  };
}

/**
 * A {@link ReferenceResolver} backed by the Rust resolver. Scheme support,
 * path-traversal checks, and the standards override chain all live there; an
 * unsupported or refused URI rejects with Rust's message.
 */
export function createBridgeReferenceResolver(client: BridgeClient): ReferenceResolver {
  return {
    async resolve(uri: string): Promise<ResolvedReference> {
      const result = await client.request(BRIDGE_METHODS.referenceResolve, { uri });
      if (!isResolvedReference(result)) {
        throw invalidResponse(BRIDGE_METHODS.referenceResolve);
      }
      return result;
    },
  };
}

/** Optional behavior for {@link createBridgeTranscriptRecorder}. */
export interface BridgeTranscriptRecorderOptions {
  /**
   * Receives a note about each entry that could not be stored. Defaults to
   * stderr — stdout is the protocol channel.
   */
  readonly onDiagnostic?: (message: string) => void;
}

/**
 * A {@link TranscriptRecorder} backed by the project's Rust transcript store
 * (ADR-013). Each entry is one `transcript.append` request; Rust files it
 * under the session the bridge is bound to.
 *
 * Requests are written in the order entries are recorded and Rust services a
 * process's requests in order, so the stored transcript keeps that order
 * without the recorder waiting for each response. A refused or failed append
 * is reported through `onDiagnostic` and otherwise dropped: the agent run
 * carries on with a gap in its transcript.
 */
export function createBridgeTranscriptRecorder(
  client: BridgeClient,
  options: BridgeTranscriptRecorderOptions = {},
): TranscriptRecorder {
  const onDiagnostic =
    options.onDiagnostic ??
    ((message: string) => {
      console.error(`transcript: ${message}`);
    });
  const inFlight = new Set<Promise<void>>();

  return {
    record(entry: TranscriptEntry): void {
      const append = client
        .request(BRIDGE_METHODS.transcriptAppend, { entry })
        .then(
          () => undefined,
          (error: unknown) => {
            const reason = error instanceof Error ? error.message : String(error);
            onDiagnostic(`dropped a ${entry.kind} entry: ${reason}`);
          },
        )
        .finally(() => {
          inFlight.delete(append);
        });
      inFlight.add(append);
    },
    async flush(): Promise<void> {
      await Promise.all(inFlight);
    },
  };
}
