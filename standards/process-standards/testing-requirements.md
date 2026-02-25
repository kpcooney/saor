# Testing Requirements

Tests are required for all non-trivial functionality and go through PR review alongside the implementation. This document defines what to test, how to test it, and how to name tests.

## What to Test Directly (No Mocks)

These components have deterministic, side-effect-free behavior that can be tested with real backends. Do not mock them — use real implementations.

**Memory store** (Rust)
- Write an entry, read it back by ID — verify all fields round-trip correctly
- Write multiple entries, run a keyword search — verify results are returned and ranked by relevance
- Run schema migration twice — verify idempotency (no errors, same schema)
- Test the FTS5 sync trigger — write an entry, verify it appears in the FTS index

**Audit store** (Rust)
- Append events, read them back — verify ordering (insertion order) and all fields
- Append events across a simulated day boundary — verify they land in the correct JSONL file
- Verify that a corrupt or missing JSONL file does not lose previously written events

**Reference resolver** (TypeScript / Rust)
- Given `standards://coding-standards/typescript`, verify it resolves to the system default when no project override exists
- Given `standards://coding-standards/typescript` with a project override present, verify the override wins
- Given `file:///docs/adr/001-foo.md`, verify it reads the correct file content
- Given an unknown URI scheme, verify an appropriate error is returned

**Identity and scope validation** (TypeScript)
- Agent with `files: ["src/**"]` — writing to `src/foo.ts` passes, writing to `docs/bar.md` is blocked
- Agent with `tools: ["Read", "Write"]` — invoking `Bash` is blocked
- Agent with `expiresAt` in the past — all tool calls are blocked
- Agent with `expiresAt` in the future — tool calls are allowed (all other checks passing)

**Standards resolution** (TypeScript or Rust)
- System default exists, no project override — returns system default
- System default exists, project override exists — returns project override
- Neither exists — returns an appropriate "not found" error

## What to Test With Mocks

These components depend on external I/O or non-deterministic behavior. Test the logic by mocking the dependency.

**Scope enforcement hook**
- Mock the tool call input and agent identity; verify the hook returns `{ action: 'block' }` for out-of-scope writes
- Mock a scope violation; verify an `AuditEvent` with `eventType: 'scope.violation'` is written to the audit store

**Audit logger hook**
- Mock a successful tool call; verify a `tool.invoked` + `tool.completed` event pair is written
- Mock a failed tool call; verify a `tool.invoked` + `tool.completed` event with `result: 'failure'` is written

**MCP server tools**
- Mock the memory store; call `memory_read` tool; verify the query is forwarded correctly and the response is formatted as expected
- Mock the reference resolver; call `resolve_ref` tool with a `standards://` URI; verify the URI is passed to the resolver and the content is returned

**Agent process manager**
- Mock subprocess spawn; verify the manager records the agent session and emits a `agent.created` audit event
- Mock process exit with code 1; verify the manager emits an `agent.failed` audit event and updates session status

## What NOT to Unit Test

- **LLM responses** — Claude Agent SDK calls are non-deterministic and require real API access. Test the harness (hooks, MCP tools, identity), not what the agent produces.
- **Tauri IPC bridge** — The IPC plumbing is Tauri's responsibility. Test the logic in command handlers, but not the `invoke()` transport itself.
- **Frontend components in Phase 1** — The UI is minimal and exploratory. Invest testing effort in the backend and agent infrastructure.

## Test Naming

Name tests to describe the behavior being verified, not the function being called:

- `test_scope_enforcement_blocks_write_outside_file_glob` ✓
- `test_enforce_scope` ✗
- `test_fts5_search_returns_results_ranked_by_bm25` ✓
- `test_search` ✗
- `test_standards_project_override_takes_precedence_over_system_default` ✓
- `test_override` ✗

## Test Location

- **Rust**: unit tests in `#[cfg(test)] mod tests { ... }` blocks in the same file as the code they test. Integration tests that span multiple modules in `src-tauri/tests/`.
- **TypeScript**: test files in `agents/tests/`, mirroring the source structure. A test for `agents/src/hooks/scope-enforcement.ts` lives at `agents/tests/hooks/scope-enforcement.test.ts`.

## Test Infrastructure

- **Rust storage tests**: use `rusqlite::Connection::open_in_memory()` — fast, no file system setup, no cleanup needed.
- **TypeScript tests**: use `vitest`. No jest, no mocha.
- **Temp directories**: for file system tests in TypeScript, use `node:os` `tmpdir()` + a unique subdirectory, and clean up in `afterEach`.
