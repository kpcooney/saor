# agents/

This is the TypeScript agent layer — a standalone Node.js package separate from `src/` (the Svelte frontend). It does **not** run in the browser. It runs in its own process space via Tauri's sidecar mechanism, which bundles and manages external processes alongside the Tauri app.

The separation from `src/` is required by the Claude Agent SDK's architecture: the SDK works by spawning Claude CLI subprocesses and communicating over stdio. That process-management model cannot run inside a browser context, so the agent layer must be a standalone Node.js package that Tauri launches as a sidecar.

This package contains:
- **`src/definitions/`** — Agent identity definitions (system prompts, tool allowlists, scope, standards references) for each SDLC agent role
- **`src/identity/`** — TypeScript types for the `AgentIdentity` schema and a factory for constructing agent instances
- **`src/hooks/`** — Lifecycle hooks: scope enforcement (PreToolUse, blocks out-of-scope actions) and audit logging (PostToolUse, records every action)
- **`src/mcp/`** — In-process MCP server definitions: memory access tools and the reference resolver (dereferences `file://`, `standards://`, `memory://`, `audit://` URIs)

- **`src/sandbox/`** — OS-sandbox configuration for the `Bash` tool: confines an agent's shell commands to its file scope and away from protected paths. The scope hook cannot path-check a shell command, so the operating system does; see [ADR-010](../docs/adr/010-bash-and-read-confinement.md)
- **`src/bridge/`** — The storage bridge: a client that exchanges line-delimited JSON with the Rust backend over this process's stdio, and the adapters that implement the memory, audit, and reference ports on top of it. This is how a launched agent reaches the Rust-owned stores; see [ADR-009](../docs/adr/009-agent-storage-bridge-transport.md)
- **`src/sidecar.ts`** / **`src/sidecar-runner.ts`** — The process entrypoint Rust launches (`node dist/sidecar.js …`) and the run logic behind it: build the Code Agent over the bridge, run it on the launch task, report the outcome

## Build & Test

All commands run from this directory (`agents/`).

```bash
npm install           # install dependencies
npm run build         # compile TypeScript (tsc)
npm test              # run tests (vitest)
npm run test:watch    # run tests in watch mode
```

### Live sandbox check

The unit suite verifies the sandbox settings Saor builds, not that the OS enforces them. To check enforcement, run a real agent session against a throwaway project (makes a few Claude API calls on the small model):

```bash
npm run build && node dist/verify-bash-sandbox.js
```

Run it from an ordinary terminal — the Claude CLI refuses to start inside another Claude Code session. Re-run it after upgrading the SDK.

## Dependencies

- **`@anthropic-ai/claude-agent-sdk`** — agent harness (spawns Claude CLI, provides hooks, MCP, subagents)
- **`zod`** v4 — schema validation. **Important**: import as `import { z } from "zod/v4"` (not `"zod"`). The SDK requires Zod v4. See `docs/verification/002-mcp-pattern-verification.md` for details.

## Key Notes

- **Stdout is a protocol channel.** In the sidecar process, stdout carries bridge requests and status lines to Rust. Never `console.log` from code that runs there — use `console.error` for diagnostics. Stray stdout lines are dropped by the Rust side, so they are lost rather than harmful.
- In-process MCP tools use `const myTool = tool(...)` — do not annotate with an explicit `SdkMcpToolDefinition` type (the generic resolves to `never`).
- SDK version verified against: `@anthropic-ai/claude-agent-sdk@0.2.58`
