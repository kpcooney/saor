# agents/

This is the TypeScript agent layer — a standalone Node.js package separate from `src/` (the Svelte frontend). It does **not** run in the browser. It runs in its own process space via Tauri's sidecar mechanism, which bundles and manages external processes alongside the Tauri app.

The separation from `src/` is required by the Claude Agent SDK's architecture: the SDK works by spawning Claude CLI subprocesses and communicating over stdio. That process-management model cannot run inside a browser context, so the agent layer must be a standalone Node.js package that Tauri launches as a sidecar.

This package contains:
- **`src/definitions/`** — Agent identity definitions (system prompts, tool allowlists, scope, standards references) for each SDLC agent role
- **`src/identity/`** — TypeScript types for the `AgentIdentity` schema and a factory for constructing agent instances
- **`src/hooks/`** — Lifecycle hooks: scope enforcement (PreToolUse, blocks out-of-scope actions) and audit logging (PostToolUse, records every action)
- **`src/mcp/`** — In-process MCP server definitions: memory access tools and the reference resolver (dereferences `file://`, `standards://`, `memory://`, `audit://` URIs)

## Build & Test

All commands run from this directory (`agents/`).

```bash
npm install           # install dependencies
npm run build         # compile TypeScript (tsc)
npm test              # run tests (vitest)
npm run test:watch    # run tests in watch mode
```

## Dependencies

- **`@anthropic-ai/claude-agent-sdk`** — agent harness (spawns Claude CLI, provides hooks, MCP, subagents)
- **`zod`** v4 — schema validation. **Important**: import as `import { z } from "zod/v4"` (not `"zod"`). The SDK requires Zod v4. See `docs/verification/002-mcp-pattern-verification.md` for details.

## Key Notes

- In-process MCP tools use `const myTool = tool(...)` — do not annotate with an explicit `SdkMcpToolDefinition` type (the generic resolves to `never`).
- SDK version verified against: `@anthropic-ai/claude-agent-sdk@0.2.58`
