# 009 — Agent Storage Bridge Transport

**Status**: accepted

## Context

The agent layer runs as a managed `node` subprocess ([ADR-002](002-agent-process-strategy.md)). The memory store, audit store, and reference resolver are owned by the Rust backend. The frontend reaches them through Tauri `invoke`, but a Node subprocess cannot call `invoke` — that channel exists only between the webview and the Rust core.

Until now the launched sidecar was a lifecycle placeholder: it could be spawned, tracked, and stopped, but it could not run the real Code Agent, because the agent's three ports (`MemoryStore`, `AuditLogger`, `ReferenceResolver`) had no implementation that reaches the Rust stores. Issue #59 builds that bridge, and it needs a transport.

The forces:

- **Single owner of storage.** Rust owns the SQLite memory database and the JSONL audit files. The agent layer must go through Rust, not open the files itself, so that path validation, the standards override chain, and the audit format stay in one place (CLAUDE.md principle 5).
- **Local-first, no new attack surface.** Nothing should listen on a port or a filesystem path that another local process could connect to (principle 6).
- **Lifetime tied to the agent run.** The channel should exist exactly as long as the agent process does, with nothing to clean up when a process is killed.
- **Already-available primitives.** `tauri-plugin-shell` gives the Rust side the child's stdout as line events and a `write` to its stdin. The sidecar's own stdin/stdout are otherwise unused: the Claude Agent SDK talks to the Claude CLI over the pipes of a *grandchild* process, not the sidecar's.
- **Testable without Tauri or an LLM.** The protocol handling must be exercisable against real stores in a plain `cargo test`.

## Decision

**Options considered:**

- **Option A: Line-delimited JSON over the sidecar's stdio** — the sidecar writes one JSON request per line to its stdout; Rust services it and writes one JSON response per line to the sidecar's stdin. Private to the parent/child pair, no setup or teardown, uses what the spawner already has. Trade-off: stdout is shared with anything else the sidecar prints, and the channel is strictly one-per-process.
- **Option B: Local socket** (Unix domain socket / Windows named pipe) — Rust listens, the sidecar connects. Clean separation from stdout and supports multiple connections. Trade-off: needs a per-session socket path, a way to authenticate the connecting process, platform-specific code, and cleanup of stale socket files when a process is killed.
- **Option C: Loopback HTTP/TCP** — Rust runs a small server on `127.0.0.1`. Familiar tooling. Trade-off: a listening port any local process can reach, so it needs a per-session token; adds an HTTP server dependency to the Rust layer; port allocation and lifecycle to manage.
- **Option D: Node opens the stores directly** (e.g. `better-sqlite3` on `memory.db`, appending to the JSONL files) — no transport at all. Trade-off: two implementations of every store and of the reference resolver's path-traversal checks, kept in sync by hand; a native Node dependency; breaks the single-owner rule.

**Chosen approach**: Option A (line-delimited JSON over stdio) — it is the only option that adds no listener, no authentication problem, and no cleanup, and it needs nothing the spawner does not already hold.

### Wire format

A protocol line ends at a line feed (`\n`, 0x0A) and at nothing else. JSON always escapes a line feed inside a string, so one cannot occur within a message. Both ends must split on exactly that byte: other characters that some line readers treat as terminators — notably U+2028 and U+2029, which JSON leaves unescaped — are ordinary payload. (The Node end originally used `node:readline`, which splits on those two characters as well; a response containing one never reached its request. See issue #68.)

Every protocol line is a single JSON object with a `kind` discriminator:

| Direction | `kind` | Shape |
|---|---|---|
| sidecar → Rust (stdout) | `request` | `{ "kind": "request", "id": 7, "method": "memory.write", "params": { … } }` |
| Rust → sidecar (stdin) | `response` | `{ "kind": "response", "id": 7, "ok": true, "result": … }` or `{ "kind": "response", "id": 7, "ok": false, "error": { "code": "…", "message": "…" } }` |
| sidecar → Rust (stdout) | `status` | `{ "kind": "status", "status": "started" \| "completed" \| "failed" \| "stopped", … }` |

`id` is a per-process counter chosen by the sidecar; responses are correlated by it, so requests may be in flight concurrently. Field names are camelCase on the wire in both directions.

The methods are storage primitives only — `memory.search`, `memory.write`, `memory.recent`, `audit.log`, `reference.resolve`. Anything that composes them (for example the `memory_context` orientation summary) stays in TypeScript, so the Rust layer holds no agent logic.

A stdout line that is not a JSON object with a known `kind` is ignored by the Rust side rather than treated as an error. This is what makes sharing stdout safe: a stray `console.log` in the agent layer or a dependency cannot corrupt the channel, it can only be dropped.

### Session binding

The Rust side of each bridge is bound to the one session and project it was spawned for. It rejects a `memory.write` or `audit.log` whose `projectId` is not that project, and an `audit.log` whose `sessionId` is not that session. A sidecar therefore cannot write into another project's stores or attribute events to another session, whatever it sends.

For this to hold, audit events written through the bridge carry the **Saor session id** (the `session-…` id the process manager assigns) in `sessionId`, so they group with the `agent.created` / `agent.completed` lifecycle events Rust records for the same run. The Claude SDK's own session id, which the hooks receive, is preserved as `details.sdkSessionId`. The bridge audit adapter in TypeScript does this mapping.

## Consequences

**Positive:**

- **No listener, no secret, no cleanup.** The channel is a pair of anonymous pipes that only the parent and child hold, and it disappears with the process.
- **Thin Tauri-dependent code.** All protocol handling is a pure `line in → line out` function over real stores, tested in a plain `cargo test`. The spawner only forwards lines.
- **One implementation of each store.** The TypeScript adapters are a few lines each; path-traversal checks, FTS5 search, and the JSONL format stay in Rust.
- **End-to-end testable without an LLM.** A Rust integration test can spawn `node`, drive the real TypeScript adapters, and service their requests against temp-dir stores.

**Negative / trade-offs:**

- **Stdout discipline.** The sidecar's stdout is now a protocol channel. Unrecognised lines are dropped, so the failure mode of a stray print is a lost log line rather than a broken bridge — but diagnostics from the agent layer must go to stderr to be seen.
- **Head-of-line and size.** Requests are serviced one at a time in arrival order, and each message is one line held in memory on both sides. Large payloads (a tool call's parameters recorded in an audit event, a big file returned by `reference.resolve`) travel as single long lines. Acceptable for one agent at a time; revisit if payloads or concurrency grow.
- **No backpressure signalling.** If the Rust side stalls, the sidecar's pending requests simply wait. The TypeScript client fails all in-flight requests if its stdin closes, so a dead parent does not hang the agent indefinitely.

**Neutral / notable:**

- **One bridge per agent process.** Concurrent agents in Phase 2 each get their own process and therefore their own bridge; nothing here needs to change for that.
- **Reversibility.** The agent layer depends only on the `MemoryStore`, `AuditLogger`, and `ReferenceResolver` ports, and the Rust handler is transport-agnostic (a line in, a line out). Moving to a socket later means replacing the TypeScript client's stream pair and the spawner's forwarding loop; the methods, the handler, and the adapters stay as they are.
- **Lifecycle events stay Rust-authored.** Rust observes every spawn, stop, and exit, so it remains the single writer of `agent.created` / `agent.completed` / `agent.failed`. The sidecar derives its identity id the same way Rust does (`agent:{type}:{session}`), so lifecycle events and the agent's own tool events share one `agentId`.

## References

- Issue: [#59 — Node↔Rust storage bridge](https://github.com/kpcooney/saor/issues/59)
- Related issues: #8 (memory MCP), #9 (reference resolver MCP), #10 (audit hook), #11 (Code Agent), #12 (IPC commands + process manager)
- Related ADRs: [001 — Audit Store JSONL File Granularity](001-audit-store-scoping.md), [002 — Agent Layer Process Strategy](002-agent-process-strategy.md), [006 — Tool Audit Hook Split](006-tool-audit-hook-split.md)
- Architecture doc: [Section 2.3 — Architecture Overview](../architecture/sdlc-agent-architecture-research-v4.md#23-architecture-overview), [Section 1.4 — Why Only Python/TypeScript SDKs](../architecture/sdlc-agent-architecture-research-v4.md#14-why-only-pythontypescript-sdks)
