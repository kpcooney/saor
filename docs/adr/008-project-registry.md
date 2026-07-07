# 008 — App-Level Project Registry

**Status**: accepted

## Context

The architecture is local-first with **one SQLite file per project** for memory (`{project}/.sdlc/memory.db`) and per-day JSONL audit files under `{project}/.sdlc/audit/`. Every store is scoped to a single project.

Implementing the Phase 1 IPC commands (issue #12) surfaced a gap: `create_project`, `list_projects`, and `get_project` need a persistent list of **which projects exist** — the "known projects" the UI opens. That index has no per-project home (a project's own store can't enumerate the others), and the architecture document does not specify where it lives.

The list is small and bounded by the number of projects a user has created (realistically tens), and it must survive app restarts. It is an *index* — project metadata only (`id`, `name`, `path`, `description`, `created_at`) — not agent activity; memory entries, audit events, and sessions stay in each project's own `.sdlc/` stores.

## Decision

**Options considered:**

- **Option A: SQLite registry in the app-data directory** — a single `registry.db` in Tauri's `app_data_dir()`, one row per project, `path` column UNIQUE. Opened once at startup and held as managed state.
- **Option B: JSON registry file** — a `projects.json` in the app-data directory holding an array of records.
- **Option C: No backend registry** — the backend stays stateless; the frontend remembers project paths (e.g. in local storage) and passes them to commands, so `list_projects` operates on a caller-supplied list.

**Chosen approach**: **Option A**. A registry insert is a single atomic row write, so a crash cannot leave a half-written, corrupt list — the failure mode a whole-file JSON rewrite (Option B) is prone to. It reuses the already-bundled `rusqlite`, gives indexed lookups and a `UNIQUE(path)` constraint that enforces "at most one project per path" for free, and keeps `list_projects()` a true backend query rather than pushing "known projects" into the UI (Option C).

The registry is deliberately an **index, not a data store**: it never grows with agent activity, only with the count of projects.

## Consequences

**Positive:**

- **Atomic, corruption-resistant writes.** Registering a project is one row insert — no whole-file rewrite to tear on a crash.
- **Constraints for free.** `UNIQUE(path)` enforces one project per path; creating onto an occupied path is refused without clobbering the existing project.
- **No new dependency.** Reuses the bundled `rusqlite`; consistent with the memory store.
- **Testable in isolation.** `ProjectRegistry::open_in_memory()` plus temp-dir project paths, mirroring the memory store's test pattern.

**Negative / trade-offs:**

- **A second store location.** Project state now lives in two places: this app-level `registry.db` and each project's own `.sdlc/`. The app-data path is Tauri-specific (`app_data_dir()`), so the registry location depends on the platform.
- **Metadata duplication.** The registry holds `id/name/path/description/created_at`; each project's own `memory.db` also holds a `projects` row (required so `memory_entries` foreign keys resolve). These are written together at `create` and can, in principle, drift if edited out-of-band. The registry is treated as the source of truth for the project list.

**Neutral / notable:**

- **Reversibility.** The registry is a self-contained module (`project::ProjectRegistry`) behind the command layer. Moving to a different backing store (or folding it into a future app-config store) would touch only that module, not the commands or the frontend contract.

## References

- Issue: [#12 — Implement Tauri IPC commands](https://github.com/kpcooney/saor/issues/12)
- Architecture doc: [Section 2.3 — Architecture Overview / IPC](../architecture/sdlc-agent-architecture-research-v4.md#23-architecture-overview)
- Related ADRs: [001 — Audit Store JSONL File Granularity](001-audit-store-scoping.md), [002 — Agent Layer Process Strategy](002-agent-process-strategy.md)
