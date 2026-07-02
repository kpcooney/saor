/**
 * agents/src/mcp/memory-server.ts
 *
 * In-process MCP server providing memory access tools to agents. Exposes three
 * tools backed by the project memory store:
 *
 *   memory_read    — keyword search over memory entries, optionally filtered by
 *                    category (learning, convention, context, index)
 *   memory_write   — store a new memory entry with a category and optional metadata
 *   memory_context — retrieve a project context summary (recent learnings and
 *                    key conventions)
 *
 * Agents call these tools to share knowledge across sessions and agent
 * boundaries. The memory layer is NOT the primary store for structured
 * artifacts — ADRs live in docs/adr/, requirements in docs/, code in source
 * control. Memory stores learnings, cross-cutting context, and the searchable
 * index that complements the reference system.
 *
 * The module is split into two layers, mirroring the scope-enforcement hook:
 *
 *   - `memoryRead` / `memoryWrite` / `memoryContext` — pure tool logic with no
 *     SDK dependency. Each takes the store, the tool context, and validated
 *     args, and returns an MCP tool result. These are the unit-tested core.
 *   - `createMemoryMcpServer` — the adapter that wraps the pure handlers in the
 *     SDK's `tool()` / `createSdkMcpServer()` shape with Zod input schemas.
 *
 * The store is injected through the {@link MemoryStore} port rather than reached
 * directly (CLAUDE.md principle 5, "abstract the backends"). The concrete
 * adapter that carries these calls across the sidecar boundary to the Rust
 * SQLite store lands with the Tauri IPC work (issue #12); this server is written
 * and tested against the port.
 *
 * See docs/architecture/sdlc-agent-architecture-research-v4.md Section 6.4 for
 * the MCP tool definitions and Section 6.2 for what belongs in memory.
 */

import { randomUUID } from 'node:crypto';

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
// z is Zod's conventional import alias — see https://zod.dev/v4/getting-started
import { z } from 'zod/v4';

import type { AgentIdentity } from '../identity/types.js';

/**
 * The category of a memory entry. Mirrors the memory store's category set
 * (Rust `MemoryCategory`): learnings, project conventions, cross-cutting
 * context, and the searchable index. Used both as a write target and as an
 * optional read filter.
 */
export type MemoryCategory = 'learning' | 'convention' | 'context' | 'index';

const MEMORY_CATEGORIES: readonly [MemoryCategory, ...MemoryCategory[]] = [
  'learning',
  'convention',
  'context',
  'index',
];

/**
 * A single memory entry. Matches the memory store's entry schema. `createdBy`
 * is the agent identity id that wrote it, `weight` is a relevance multiplier
 * (default 1.0), and `metadata` is optional structured context.
 */
export interface MemoryEntry {
  readonly id: string;
  readonly projectId: string;
  readonly category: MemoryCategory;
  readonly content: string;
  readonly metadata: Record<string, unknown>;
  readonly createdBy: string;
  /** ISO 8601 timestamp of when the entry was written. */
  readonly createdAt: string;
  readonly weight: number;
}

/** Options for a keyword search against the memory store. */
export interface KeywordSearchOptions {
  /** Restrict the search to a single category. */
  readonly category?: MemoryCategory;
  /** Maximum number of entries to return. */
  readonly limit?: number;
}

/**
 * A summary of a project's memory, returned by `memory_context`. Intentionally
 * modest in Phase 1: the recent learnings and the standing conventions an agent
 * should orient on before starting work.
 */
export interface ProjectContext {
  readonly projectId: string;
  readonly recentLearnings: readonly MemoryEntry[];
  readonly conventions: readonly MemoryEntry[];
}

/**
 * The port through which the memory tools reach the store. Kept to just the
 * operations the tools use, so the concrete IPC-backed implementation (issue
 * #12) has a small, clear contract to satisfy and tests can supply a fake.
 */
export interface MemoryStore {
  /** Keyword-search entries, ordered most-relevant first. */
  keywordSearch(
    query: string,
    options?: KeywordSearchOptions,
  ): Promise<readonly MemoryEntry[]>;
  /** Persist a memory entry. */
  write(entry: MemoryEntry): Promise<void>;
  /** Build the orientation summary for a project. */
  getProjectContext(projectId: string): Promise<ProjectContext>;
}

/**
 * The ambient context the memory tools run in: which project the entries belong
 * to, which agent is acting (stamped as `createdBy` on writes), and the memory
 * categories the agent may read and write. The category allowlists come from
 * the agent's scope (`AgentScope.memoryNamespaces`) — see
 * {@link memoryToolContextFromIdentity}.
 */
export interface MemoryToolContext {
  readonly projectId: string;
  readonly agentId: string;
  /** Categories this agent may read. An empty list means it can read nothing. */
  readonly readableCategories: readonly string[];
  /** Categories this agent may write. An empty list means it can write nothing. */
  readonly writableCategories: readonly string[];
}

/**
 * Derive a {@link MemoryToolContext} from an agent identity and the current
 * project. The read/write category allowlists are taken from the identity's
 * `scope.memoryNamespaces`, so the memory tools enforce the same namespace
 * boundaries the identity declares.
 */
export function memoryToolContextFromIdentity(
  identity: AgentIdentity,
  projectId: string,
): MemoryToolContext {
  return {
    projectId,
    agentId: identity.id,
    readableCategories: identity.scope.memoryNamespaces.read,
    writableCategories: identity.scope.memoryNamespaces.write,
  };
}

/**
 * The MCP server name for the memory tools. Exported so callers that both
 * register the server (as the `mcpServers` record key) and grant its tools
 * (which the SDK namespaces as `mcp__{serverName}__{tool}`) derive both from a
 * single source, and cannot drift out of sync. See `createMemoryMcpServer`.
 */
export const MEMORY_MCP_SERVER_NAME = 'project-memory';

/** Default number of entries returned by `memory_read` when no limit is given. */
export const DEFAULT_MEMORY_READ_LIMIT = 10;
/** Upper bound on `memory_read` results, to keep a single call's payload bounded. */
export const MAX_MEMORY_READ_LIMIT = 100;

/**
 * The shape the memory tools return to the SDK. A single text block carrying a
 * JSON payload (or, on `isError`, a human-readable failure message).
 */
interface MemoryToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

function ok(payload: unknown): MemoryToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

function toolError(message: string): MemoryToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Validated input to {@link memoryRead}. */
export interface MemoryReadArgs {
  readonly query: string;
  readonly category?: MemoryCategory;
  readonly limit?: number;
}

/** Validated input to {@link memoryWrite}. */
export interface MemoryWriteArgs {
  readonly category: MemoryCategory;
  readonly content: string;
  readonly metadata?: Record<string, unknown>;
}

/** Injectable clock and id generator, for deterministic tests. */
export interface MemoryToolDeps {
  readonly now?: () => Date;
  readonly generateId?: () => string;
}

/**
 * `memory_read` — keyword-search the project's memory.
 *
 * Namespace enforcement: a `category` that the agent may not read is rejected,
 * and results are filtered to the agent's readable categories regardless of the
 * query (defense in depth — the store is trusted to search, not to authorize).
 */
export async function memoryRead(
  store: MemoryStore,
  context: MemoryToolContext,
  args: MemoryReadArgs,
): Promise<MemoryToolResult> {
  if (args.category !== undefined && !context.readableCategories.includes(args.category)) {
    return toolError(
      `memory_read denied: category "${args.category}" is not in this agent's readable memory namespaces`,
    );
  }

  const limit = clampLimit(args.limit);

  let results: readonly MemoryEntry[];
  try {
    results = await store.keywordSearch(args.query, {
      ...(args.category !== undefined ? { category: args.category } : {}),
      limit,
    });
  } catch (error) {
    return toolError(`memory_read failed: ${describeError(error)}`);
  }

  const readable = results.filter((entry) =>
    context.readableCategories.includes(entry.category),
  );
  return ok({ results: readable });
}

/**
 * `memory_write` — store a memory entry authored by the current agent.
 *
 * Namespace enforcement: writing to a category the agent may not write is
 * rejected. The system fields (`id`, `projectId`, `createdBy`, `createdAt`,
 * `weight`) are stamped here, not taken from the caller, so an agent cannot
 * forge authorship or write into another project.
 */
export async function memoryWrite(
  store: MemoryStore,
  context: MemoryToolContext,
  args: MemoryWriteArgs,
  deps: MemoryToolDeps = {},
): Promise<MemoryToolResult> {
  if (!context.writableCategories.includes(args.category)) {
    return toolError(
      `memory_write denied: category "${args.category}" is not in this agent's writable memory namespaces`,
    );
  }

  const generateId = deps.generateId ?? (() => randomUUID());
  const now = deps.now ?? (() => new Date());

  const entry: MemoryEntry = {
    id: generateId(),
    projectId: context.projectId,
    category: args.category,
    content: args.content,
    metadata: args.metadata ?? {},
    createdBy: context.agentId,
    createdAt: now().toISOString(),
    weight: 1.0,
  };

  try {
    await store.write(entry);
  } catch (error) {
    return toolError(`memory_write failed: ${describeError(error)}`);
  }

  return ok({ id: entry.id, category: entry.category, createdAt: entry.createdAt });
}

/**
 * `memory_context` — the orientation summary for the current project. Filtered
 * to the agent's readable categories so it never surfaces memory the agent is
 * not scoped to read.
 */
export async function memoryContext(
  store: MemoryStore,
  context: MemoryToolContext,
): Promise<MemoryToolResult> {
  let projectContext: ProjectContext;
  try {
    projectContext = await store.getProjectContext(context.projectId);
  } catch (error) {
    return toolError(`memory_context failed: ${describeError(error)}`);
  }

  const filtered: ProjectContext = {
    projectId: projectContext.projectId,
    recentLearnings: projectContext.recentLearnings.filter((entry) =>
      context.readableCategories.includes(entry.category),
    ),
    conventions: projectContext.conventions.filter((entry) =>
      context.readableCategories.includes(entry.category),
    ),
  };
  return ok(filtered);
}

/** Clamp a caller-supplied limit into `[1, MAX_MEMORY_READ_LIMIT]`. */
function clampLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return DEFAULT_MEMORY_READ_LIMIT;
  }
  return Math.max(1, Math.min(limit, MAX_MEMORY_READ_LIMIT));
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Configuration for {@link createMemoryMcpServer}. */
export interface MemoryMcpServerConfig extends MemoryToolDeps {
  /** The store the tools read from and write to. */
  readonly store: MemoryStore;
  /** The project and agent the tools act on behalf of. */
  readonly context: MemoryToolContext;
}

/**
 * Build the in-process MCP server that exposes the memory tools. Register the
 * returned config with the SDK via `options.mcpServers`.
 */
export function createMemoryMcpServer(
  config: MemoryMcpServerConfig,
): McpSdkServerConfigWithInstance {
  const { store, context } = config;
  const deps: MemoryToolDeps = { now: config.now, generateId: config.generateId };

  const readTool = tool(
    'memory_read',
    'Keyword-search the project memory for relevant learnings, conventions, and context.',
    {
      query: z.string().describe('Keyword search query (FTS5 syntax supported).'),
      category: z
        .enum(MEMORY_CATEGORIES)
        .optional()
        .describe('Restrict the search to a single memory category.'),
      limit: z
        .number()
        .int()
        .positive()
        .max(MAX_MEMORY_READ_LIMIT)
        .optional()
        .describe(`Maximum entries to return (default ${DEFAULT_MEMORY_READ_LIMIT}).`),
    },
    async (args) => memoryRead(store, context, args),
  );

  const writeTool = tool(
    'memory_write',
    'Store a memory entry (a learning, convention, or piece of context) for other agents and future sessions.',
    {
      category: z.enum(MEMORY_CATEGORIES).describe('The memory category to write to.'),
      content: z.string().describe('The knowledge to store.'),
      metadata: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('Optional structured metadata to attach to the entry.'),
    },
    async (args) => memoryWrite(store, context, args, deps),
  );

  const contextTool = tool(
    'memory_context',
    'Retrieve the orientation summary for the current project: recent learnings and standing conventions.',
    {},
    async () => memoryContext(store, context),
  );

  return createSdkMcpServer({
    name: MEMORY_MCP_SERVER_NAME,
    tools: [readTool, writeTool, contextTool],
  });
}
