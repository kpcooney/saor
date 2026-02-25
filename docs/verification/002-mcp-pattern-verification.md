# Verification: createSdkMcpServer In-Process MCP Pattern

**Date**: 2026-02-25
**Issue**: [#2 — Verify createSdkMcpServer in-process MCP pattern](https://github.com/kpcooney/saor/issues/2)
**SDK Version**: @anthropic-ai/claude-agent-sdk@0.2.58

## Summary

The `createSdkMcpServer` and `tool` functions from the Claude Agent SDK work as described in the architecture document (Sections 1.2, 5.4, 6.4). The in-process MCP server pattern is confirmed viable for Saor's memory MCP server and reference resolver.

## What Was Verified

1. **`createSdkMcpServer()`** creates an `McpSdkServerConfigWithInstance` with `type: 'sdk'`, a `name`, and a live `McpServer` `instance`.
2. **`tool()`** defines tools with Zod input schemas and async handlers returning `CallToolResult` (`{ content: [{ type: "text", text: ... }] }`).
3. **The returned config** can be passed directly to `query()` via `options.mcpServers`, enabling in-process tool invocation without subprocess overhead.
4. **Hook types** (`PreToolUseHookInput`, `PostToolUseHookInput`, `HookCallback`, `HookCallbackMatcher`) are available and match the shapes needed for scope enforcement and audit logging.
5. **Agent definitions** (`AgentDefinition`) support the fields needed for the Code Agent: `description`, `prompt`, `tools`, `model`.

## API Deltas from Architecture Document

### Delta 1: Zod v4 Required

The SDK has a peer dependency on `zod@^4.0.0`. The architecture document examples and our `package.json` originally specified `zod@^3.24.0`.

**Impact**: Updated `agents/package.json` from `zod@^3.24.0` to `zod@^4.0.0`. Import path for Zod in agent code should use `import { z } from "zod/v4"` to match the SDK's own import pattern.

**Affected files**: All TypeScript files in `agents/src/` that use Zod schemas — `mcp/memory-server.ts`, `mcp/reference-resolver.ts`, and any future MCP tool definitions.

### Delta 2: SdkMcpToolDefinition Generic Inference

The `SdkMcpToolDefinition` type is generic (`SdkMcpToolDefinition<Schema>`). When used without a type parameter, the default resolves to `never` for handler args. Tool definitions should rely on TypeScript's type inference from `tool()` rather than explicit `SdkMcpToolDefinition` annotations.

**Impact**: Minor. Use `const myTool = tool(...)` instead of `const myTool: SdkMcpToolDefinition = tool(...)`. The architecture doc code examples work correctly when you omit the explicit type annotation.

### No Other Deltas

The core pattern — `createSdkMcpServer({ name, tools: [tool(...)] })` — works exactly as described. The architecture document's code examples in Sections 5.4 and 6.4 are accurate.

## Verification Script

The verification script lives at `agents/src/verify-mcp-pattern.ts`. It serves as both a compile-time type check and a runtime structural validation.

```
cd agents && npm run build && node dist/verify-mcp-pattern.js
```

## Implications for Downstream Issues

- **Issue #8 (Memory MCP server)**: Can proceed as designed. Use `zod/v4` imports.
- **Issue #9 (Reference resolver MCP tool)**: Can proceed as designed. Use `zod/v4` imports.
- **Issue #7 (Agent identity and scope enforcement)**: Hook types confirmed available. `PreToolUse` hook can return `permissionDecision: 'allow' | 'deny'` as needed for scope enforcement.
- **Issue #10 (Audit logging PostToolUse hook)**: `PostToolUseHookInput` provides `tool_name`, `tool_input`, and `tool_response` — sufficient for audit event construction.
