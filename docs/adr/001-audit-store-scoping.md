# 001 — Audit Store JSONL File Granularity

**Status**: proposed

## Context

Phase 1 of Saor uses a JSONL-based audit store (`FileSystemAuditStore`) as the initial backend for the audit trail. The store writes append-only files to `{project}/.sdlc/audit/`. Before implementation begins, the file granularity strategy must be decided: should the store create **one file per calendar day** or **one file per agent session**?

This decision affects:

- **Queryability**: How easy it is to find events by time range, by session, or by agent using standard Unix tools (`grep`, `jq`, `cat`).
- **File count at scale**: How many files accumulate in the audit directory over weeks and months of active development.
- **UI consumption**: How the audit viewer component loads and displays events.
- **Single-session replay**: How practical it is to isolate and replay the events from one agent session.

Every `AuditEvent` carries a `sessionId` field (see architecture doc Section 8.2), so per-session filtering is possible regardless of file granularity. The question is whether the file system layout should optimize for temporal grouping or session isolation.

## Decision

**Options considered:**

- **Option A: Per-day files** — One JSONL file per calendar day, named `YYYY-MM-DD.jsonl`. All sessions that occur on the same day write to the same file. Events from concurrent sessions are interleaved chronologically.
- **Option B: Per-session files** — One JSONL file per agent session, named `{sessionId}.jsonl`. Each file contains only the events from a single session. Session IDs are UUIDs or similarly unique identifiers.

**Chosen approach**: Option A (per-day files) — it keeps file count bounded, aligns with the architecture doc's example path, and the `sessionId` field on every event already enables per-session filtering without needing per-session files.

## Consequences

**Positive:**

- **Bounded file count.** File count grows at most one per day, regardless of how many sessions run. A year of daily use produces ~365 files. Per-session could produce thousands — every agent spawn creates a file, and a multi-agent session in later phases could create dozens per day.
- **Natural time-range queries.** "What happened yesterday?" maps directly to reading one file. Time-range queries (last week, last month) map to a predictable set of files by name. No need to inspect file contents or metadata to find the right time window.
- **Grep-friendly.** A single day's events are in one file, so `grep "scope.violation" 2026-02-25.jsonl` gives all violations for the day. Cross-session patterns (e.g., repeated scope violations across sessions) are visible in one file without concatenating.
- **Simpler append logic.** The store resolves today's date, opens or creates that file, and appends. No need to track which session maps to which file, and no risk of orphaned files from sessions that fail to close cleanly.
- **Aligns with architecture doc.** Section 8.4 uses `/project/.sdlc/audit/2026-02-22.jsonl` as the example path, which is per-day naming.

**Negative / trade-offs:**

- **Interleaved sessions.** When multiple sessions run on the same day, their events are interleaved in the file. Reading a single session's events requires filtering by `sessionId`. This is a `jq` one-liner (`jq 'select(.sessionId == "abc")' 2026-02-25.jsonl`) and the `getBySession()` query method handles it in code, but it's not as immediate as opening a dedicated file.
- **Large files on busy days.** A day with heavy agent activity could produce a large file. In practice, Phase 1 runs a single agent at a time, so this is unlikely to be a problem. The future `SqliteAuditStore` upgrade path (Section 8.4) handles scale — JSONL is explicitly the "early development and debugging" backend.
- **No atomic session files.** You cannot hand someone a single file representing "everything agent X did in session Y." Instead, you extract it with a filter. This is a minor ergonomic cost.

**Neutral / notable:**

- **File path pattern**: `{project}/.sdlc/audit/YYYY-MM-DD.jsonl` (e.g., `.sdlc/audit/2026-02-25.jsonl`).
- **Rotation is implicit.** A new file starts each calendar day. No explicit rotation logic needed.
- **The `sessionId` field is the primary tool for per-session queries.** This is true regardless of file granularity and is already part of the event schema.
- **Migration to SqliteAuditStore** (Phase 2+) will ingest JSONL files regardless of naming convention. Per-day files are marginally simpler to ingest in chronological order since filenames sort naturally.

## References

- Issue: [#1 — Write ADR-001: Audit store JSONL scoping](https://github.com/kpcooney/saor/issues/1)
- Architecture doc: [Section 8.2 — Event Schema](../architecture/sdlc-agent-architecture-research-v4.md#82-event-schema)
- Architecture doc: [Section 8.4 — Backend Implementations](../architecture/sdlc-agent-architecture-research-v4.md#84-backend-implementations)
- ADR template: [template.md](template.md)
