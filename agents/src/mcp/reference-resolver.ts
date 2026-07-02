/**
 * agents/src/mcp/reference-resolver.ts
 *
 * In-process MCP server providing the `resolve_ref` tool, which dereferences
 * the URI-scheme references carried in reference manifests. Agents use it to
 * pull context on demand rather than receiving pre-packaged, lossy summaries —
 * the runtime side of the Reference-Based Handoff Protocol, the novel core of
 * the Saor architecture.
 *
 * Supported URI schemes (resolution is owned by the resolver, not this tool):
 *   file://      — read a file from the project directory
 *   standards:// — resolve a standards reference through the three-tier chain
 *                  (agent-specific → project overrides → system defaults)
 *   memory://    — query the memory store
 *   audit://     — query the audit trail (deferred)
 *   tracker://   — fetch an issue/epic/initiative (Phase 3, not yet implemented)
 *
 * The module is split into two layers, mirroring the memory MCP server:
 *
 *   - `resolveReference` — pure tool logic with no SDK dependency: validate the
 *     URI, delegate to the resolver, and shape the result. Unit-tested core.
 *   - `createReferenceResolverMcpServer` — the adapter that wraps the pure
 *     handler in the SDK's `tool()` / `createSdkMcpServer()` shape.
 *
 * Resolution runs behind the {@link ReferenceResolver} port rather than reaching
 * the Rust resolver directly (CLAUDE.md principle 5, "abstract the backends").
 * The concrete adapter that carries a `resolve` call across the sidecar boundary
 * to the Rust resolver (`src-tauri/src/references/`) lands with the Tauri IPC
 * work (issue #12); this tool is written and tested against the port. Scheme
 * support — including which schemes are still deferred — is owned by the
 * resolver, so it lives in one place rather than being duplicated here.
 *
 * See docs/architecture/sdlc-agent-architecture-research-v4.md Section 5 for the
 * full reference manifest pattern and resolver design.
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
// z is Zod's conventional import alias — see https://zod.dev/v4/getting-started
import { z } from 'zod/v4';

/**
 * The result of dereferencing a URI. A discriminated union mirroring the Rust
 * resolver's `ResolvedReference`:
 *
 *   - `content` — text-bearing references (`file://`, `standards://`)
 *   - `memory`  — a set of memory entries (`memory://`)
 *
 * Memory entries are carried as opaque values: `resolve_ref` is a generic
 * dereferencer that hands resolved content to the agent, so it does not depend
 * on the memory entry schema (owned by the memory store / memory MCP server).
 */
export type ResolvedReference =
  | { readonly kind: 'content'; readonly uri: string; readonly content: string }
  | { readonly kind: 'memory'; readonly uri: string; readonly entries: readonly unknown[] };

/**
 * The port through which `resolve_ref` dereferences a URI. Kept to the single
 * operation the tool uses, so the concrete IPC-backed implementation (issue
 * #12) has a small, clear contract and tests can supply a fake. The resolver
 * owns scheme dispatch and rejects unknown or deferred schemes.
 */
export interface ReferenceResolver {
  resolve(uri: string): Promise<ResolvedReference>;
}

/**
 * The shape the tool returns to the SDK: a single text block carrying a JSON
 * payload, or, on `isError`, a human-readable failure message. (Kept local to
 * this module; the memory MCP server uses the same shape.)
 */
interface ToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

function ok(payload: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

function toolError(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Extract the scheme from a reference URI (`scheme://...`), lowercased, or
 * `undefined` when the string is not a well-formed scheme URI. Only the syntax
 * is checked here — whether the scheme is actually supported is the resolver's
 * call.
 */
export function parseScheme(uri: string): string | undefined {
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(uri);
  return match ? match[1]!.toLowerCase() : undefined;
}

/** Validated input to {@link resolveReference}. */
export interface ResolveReferenceArgs {
  readonly uri: string;
}

/**
 * `resolve_ref` — dereference a single reference URI through the resolver.
 *
 * Input validation is limited to well-formedness (the URI must be a
 * `scheme://…` string); scheme support is the resolver's responsibility, so an
 * unknown or deferred scheme surfaces as a resolver error rather than being
 * pre-judged here. Any resolver failure (unknown scheme, not found, I/O) is
 * returned as an error result so the agent can react, rather than throwing.
 */
export async function resolveReference(
  resolver: ReferenceResolver,
  args: ResolveReferenceArgs,
): Promise<ToolResult> {
  const scheme = parseScheme(args.uri);
  if (scheme === undefined) {
    return toolError(
      `resolve_ref: "${args.uri}" is not a valid reference URI (expected scheme://path)`,
    );
  }

  try {
    const resolved = await resolver.resolve(args.uri);
    return ok(resolved);
  } catch (error) {
    return toolError(`resolve_ref failed for ${args.uri}: ${describeError(error)}`);
  }
}

/**
 * The MCP server name for the `resolve_ref` tool. Exported so callers that both
 * register the server (as the `mcpServers` record key) and grant its tool
 * (which the SDK namespaces as `mcp__{serverName}__resolve_ref`) derive both
 * from a single source, and cannot drift out of sync. See
 * `createReferenceResolverMcpServer`.
 */
export const REFERENCE_RESOLVER_MCP_SERVER_NAME = 'reference-resolver';

/** Configuration for {@link createReferenceResolverMcpServer}. */
export interface ReferenceResolverMcpServerConfig {
  /** The resolver the tool dereferences URIs through. */
  readonly resolver: ReferenceResolver;
}

/**
 * Build the in-process MCP server that exposes the `resolve_ref` tool. Register
 * the returned config with the SDK via `options.mcpServers`.
 */
export function createReferenceResolverMcpServer(
  config: ReferenceResolverMcpServerConfig,
): McpSdkServerConfigWithInstance {
  const { resolver } = config;

  const resolveTool = tool(
    'resolve_ref',
    'Dereference a reference URI to pull context on demand. Schemes: ' +
      'file:// (a project file), standards:// (a standard via the three-tier chain), ' +
      'memory:// (memory entries). audit:// and tracker:// are not yet available.',
    {
      uri: z
        .string()
        .min(1)
        .describe(
          'A reference URI, e.g. file:///docs/adr/007-review-truth-model.md, ' +
            'standards://coding-standards/typescript, or memory://learning/auth.',
        ),
    },
    async (args) => resolveReference(resolver, args),
  );

  return createSdkMcpServer({
    name: REFERENCE_RESOLVER_MCP_SERVER_NAME,
    tools: [resolveTool],
  });
}
