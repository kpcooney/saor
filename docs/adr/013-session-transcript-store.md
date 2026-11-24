# 013 — Session Transcript Store

**Status**: accepted

## Context

A launched Code Agent ran, and the app showed a status pill. The sidecar read the SDK's final `result` message to decide between `completed` and `failed`, and discarded everything else the agent said — including its final answer. The only trace of a run was the tool events in the audit trail. In the first live smoke test (2026-11-23) the agent created a file and the app could not say what it had done or why two tool calls were blocked; that had to be reconstructed by reading the raw audit JSONL.

Saor cannot be used to build Saor until a run is legible from inside it. Issue #78 adds a session view, and the view needs somewhere to read the agent's words from. Nothing in the architecture document says where those live.

The forces:

- **The audit trail is forensic and is about actions.** Its event types are tool calls, scope violations, lifecycle and decisions (architecture Section 8). It must never lose an event, and it is written by hooks the agent cannot opt out of (principle 4).
- **Reference over copies** (principle 1). The audit trail already holds every tool call with its parameters and outcome. A second copy of that in another store would be a thing to keep in sync.
- **Rust owns storage** (principle 5, ADR-009). The sidecar reaches stores through the bridge; it does not open project files itself.
- **Local-first, simplest backend first** (principles 5 and 6).
- **A transcript is read whole, by session, and while the run is in progress.** The session view opens one session and follows it.
- **A transcript is not evidence.** If a line is lost, the audit trail still says what the agent did. Recording it must never be able to fail or stall an agent run.

## Decision

**Options considered:**

- **Option A: A per-session transcript file, written through the bridge** — a new store, `{project}/.sdlc/sessions/{sessionId}.jsonl`, one line per entry; a new bridge method `transcript.append`; a new IPC command `agent_transcript`. Entries record what the agent said and reference its tool calls by id. Trade-off: a third store beside memory and audit, and the UI must join two records.
- **Option B: Put the agent's messages in the audit trail** — a new audit event type (`agent.message`) whose details carry the text. No new store, bridge method, or command. Trade-off: it changes what the audit trail is. Message text is large and unstructured next to action events, every audit query and the audit viewer would have to filter it out, and "never lose an event" would extend to prose that is not evidence of anything.
- **Option C: Persist the raw SDK message stream** — write every `SDKMessage` as received. Complete, and nothing to decide about shape. Trade-off: couples an on-disk format to an SDK version, stores every tool input and output a second time (some of it large), and still needs a reducer before anything can be shown.
- **Option D: Stream messages to the UI as events, store nothing** — Rust re-emits each line as a Tauri event. Trade-off: a session is unreadable the moment it scrolls past, after switching projects, or after restarting the app; and the spawner's forwarding loop, which is deliberately untested glue, would grow logic.

**Chosen approach**: Option A — it keeps the audit trail what it is, stores each fact once, and adds only a store and a bridge method of the kinds that already exist.

### What is stored

One JSON object per line, camelCase, in the order the agent produced them:

```
{ "sessionId", "timestamp", "kind", "text", "details" }
```

| `kind` | `text` | `details` |
|---|---|---|
| `task` | the task the agent was launched with | `{}` |
| `message` | what the agent said in one turn; empty when the turn was only tool calls | `{ "toolUseIds": [...] }` — the calls made that turn, by id, when there were any |
| `result` | the final answer, or the error the run ended with | `{ "isError", "numTurns"?, "durationMs"?, "totalCostUsd"? }` |

A tool call's name, parameters and outcome are **not** in the transcript. `toolUseIds` are the same ids the audit hooks record as `details.toolUseId` (ADR-006), and the session view joins the two records on them.

### How it gets there

- The sidecar builds entries from the SDK message stream (`agents/src/transcript/entries.ts`) and sends each as a `transcript.append` request over the storage bridge (ADR-009). It does not wait for a response before continuing: requests are written in order and Rust services one process's requests in order, so the file keeps that order.
- The sidecar sends no session id. `BridgeHost` files every entry under the session it is bound to, so a run cannot write into another session's transcript whatever it sends.
- The `result` entry is stored before the sidecar's final status line, so a reader who sees the run end finds the transcript complete.
- A refused or failed append is reported on the sidecar's stderr and dropped. The run continues.

### How it is read

`agent_transcript(projectId, sessionId)` returns the entries in order; a session with no transcript returns an empty list. The session id becomes a file name, so it is restricted to letters, digits, `-` and `_` before it is used as one. A line that does not parse is skipped without being reported.

The append itself is shared with the audit store (`src-tauri/src/jsonl.rs`), so an entry is never glued onto a line torn by a crash (issue #74).

## Consequences

**Positive:**
- A run is legible from inside Saor: the task, what the agent said, its tool calls with outcomes, the files it changed, and how it ended.
- The record is on disk under the project, so it survives the agent process and an app restart, and a later session-list feature has something to list.
- Each fact is stored once. The audit trail's meaning and its queries are unchanged.
- `.sdlc/` is outside every agent's file scope and hidden from its shell (ADR-010), so an agent cannot read or rewrite its own transcript; it can only append through the bridge.

**Negative / trade-offs:**
- The session view depends on two records and a join. A session that predates this ADR, or a transcript with a gap, shows tool calls positioned by time alone.
- The join relies on `details.toolUseId` in audit events. A scope-hook `tool.blocked` event does not carry that id today, so the view matches it to its call by tool name and time. If the hook starts recording the id, the heuristic can go.
- The transcript stores model output verbatim, in plain text, in the project directory. It is not redacted. The same is already true of tool parameters in the audit trail.
- Transcripts are never pruned. One file per session, small, but unbounded in number — the same position as the audit trail before its Phase 4 SQLite migration.
- A transcript line can be lost (a failed append, a torn line) without anything surfacing in the UI. That is the accepted price of recording never being able to fail a run.

**Neutral / notable:**
- The transcript is not an input to any agent. It is a record for the human. Handoffs between agents remain reference manifests (architecture Section 5); nothing here is a summary passed between agents.
- Only assistant turns are recorded. Thinking blocks and tool results are not.
- If audit moves to SQLite (architecture Section 8.4), transcripts can move with it behind the same bridge method and command.

## References

- Issue: #78
- Related ADRs: [ADR-001](001-audit-store-scoping.md) (audit JSONL), [ADR-006](006-tool-audit-hook-split.md) (`toolUseId` correlation), [ADR-009](009-agent-storage-bridge-transport.md) (the bridge), [ADR-010](010-bash-and-read-confinement.md) (`.sdlc/` is protected)
- Architecture doc: [Section 2.3 — communication flow](../architecture/sdlc-agent-architecture-research-v4.md), [Section 8 — Audit Trail](../architecture/sdlc-agent-architecture-research-v4.md)
