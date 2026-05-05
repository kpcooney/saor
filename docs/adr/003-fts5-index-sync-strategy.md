# 003 — FTS5 Index Sync Strategy

**Status**: proposed

## Context

The memory store uses SQLite's FTS5 extension for keyword search over `memory_entries`. FTS5 with a content table (`content='memory_entries'`) requires an explicit mechanism to keep the FTS index in sync with the source table — FTS5 does not auto-sync when using content tables.

Two approaches exist: SQLite triggers that fire on every insert/update/delete to mirror changes into the FTS index, or explicit Rust-side sync where each store method manually updates both `memory_entries` and `memory_fts` in the same transaction.

The decision affects correctness risk (can the index drift?), code visibility (is the sync mechanism apparent to Rust developers?), and extensibility (how does this pattern translate to other backends like Postgres?).

## Decision

**Options considered:**

- **Option A: SQLite triggers** — Three triggers (after insert, after delete, after update) on `memory_entries` automatically mirror every change into `memory_fts`. This is SQLite's prescribed pattern for content table FTS indexes.

- **Option B: Explicit Rust-side sync** — Every `SqliteMemoryStore` method that writes to `memory_entries` also explicitly updates `memory_fts` within the same transaction. The sync logic lives in Rust code, not SQL.

**Chosen approach**: Option A (SQLite triggers) — the index cannot drift regardless of how entries are written, because the sync is enforced at the database level. The triggers are documented prominently in `schema.rs` alongside the table definitions, making them visible to Rust developers reading the schema. Each future backend (Postgres, Elasticsearch) will implement its own sync mechanism appropriate to that platform, so the choice here does not constrain future backends.

## Consequences

**Positive:**

- **Cannot drift.** Any write to `memory_entries` — whether through `SqliteMemoryStore`, a manual SQL statement, or a future code path — automatically updates the FTS index. There is no risk of forgetting to update the index when adding a new write method.
- **Follows SQLite's prescribed pattern.** The FTS5 documentation explicitly recommends triggers for content table sync. Using the recommended pattern reduces the risk of subtle bugs.
- **Simpler store methods.** `write_entry()` only needs to INSERT into `memory_entries`. The FTS update is handled transparently.

**Negative / trade-offs:**

- **Sync mechanism is in SQL, not Rust.** Developers reading `store.rs` won't see the FTS update — they need to look at `schema.rs` where the triggers are defined. Mitigated by doc comments in `store.rs` pointing to the triggers.
- **Triggers are implicit.** If a developer unfamiliar with FTS5 encounters the triggers, they may wonder why they exist. Mitigated by comments explaining the pattern in `schema.rs`.

**Neutral / notable:**

- **Backend-specific by nature.** Postgres would use a `GENERATED ALWAYS AS tsvector` column or a GIN index, not triggers. Elasticsearch would use an explicit API call. The sync mechanism is always an implementation detail of the specific backend — not part of the `MemoryStore` abstraction interface.
- **Triggers are defined in `schema.rs`.** They are part of the schema initialization, visible alongside the table definitions, not hidden in a separate migration file.

## References

- Issue: [#4 — Implement SQLite memory store with FTS5](https://github.com/kpcooney/saor/issues/4)
- Architecture doc: [Section 6.3 — SQLite + FTS5 Schema](../architecture/sdlc-agent-architecture-research-v4.md#63-implementation-sqlite--fts5)
- Architecture doc: [Section 6.7 — Abstraction Interface](../architecture/sdlc-agent-architecture-research-v4.md#67-abstraction-for-future-portability)
- Implementation: `src-tauri/src/memory/schema.rs` (trigger definitions)
- Related ADRs: [001 — Audit Store JSONL File Granularity](001-audit-store-scoping.md), [002 — Agent Layer Process Strategy](002-agent-process-strategy.md)
