# Issue Format Standard

Well-written issues are the input to the agent work hierarchy. A clear issue means an agent can start work immediately without asking clarifying questions. Use this format for all GitHub issues in this project.

## Title

Imperative mood, describes the outcome, not the activity. Short enough to read in a list.

- `Implement SQLite memory store with FTS5` ✓
- `Working on memory store` ✗
- `SQLite` ✗ (too vague)

## Template

```markdown
## Problem Statement

What needs to happen and why. One to three sentences. If this is a bug, describe the
observed vs. expected behavior. If it's a feature, describe the gap being filled.

## Acceptance Criteria

Testable, specific conditions for "done". Each item should be independently verifiable.

- [ ] Memory entries can be written and read back by ID
- [ ] FTS5 search returns results ranked by relevance for a multi-word query
- [ ] Schema migration runs on first open without manual intervention
- [ ] Tests pass: `cargo test -p saor-lib memory`

## Definition of Done

- [ ] Implementation complete per acceptance criteria
- [ ] Tests written and passing (unit + integration as applicable)
- [ ] Module-level documentation updated
- [ ] PR description follows pr-format standard
- [ ] PR reviewed and approved

## References

- Initiative: *(tracker reference, e.g., PROJ-100)*
- Epic: *(tracker reference, e.g., PROJ-142)*
- Related ADRs: *(links to relevant ADRs)*
- Architecture doc: *(link to relevant section)*

## Labels

- Type: `feat` | `fix` | `chore` | `docs`
- Scope: `tauri` | `frontend` | `agents` | `memory` | `audit` | `mcp` | `standards`
```

## Example

```markdown
**Title**: Implement SQLite memory store with FTS5

## Problem Statement

Phase 1 requires a local-first memory layer so agents can share learnings and project
context across sessions. The memory store must support keyword search from day one —
FTS5 is the chosen mechanism per the architecture document.

## Acceptance Criteria

- [ ] `memory_entries` and `agent_sessions` tables created on first open
- [ ] `memory_fts` FTS5 virtual table created and kept in sync with `memory_entries`
- [ ] `write_entry(entry)` persists a memory entry and updates the FTS index
- [ ] `keyword_search(query, limit)` returns entries ranked by BM25 relevance
- [ ] Schema migrations run idempotently — running twice has no effect
- [ ] All operations tested with an in-memory SQLite database (not mocks)

## Definition of Done

- [ ] Implementation complete per acceptance criteria
- [ ] Tests written and passing
- [ ] `memory/mod.rs` doc comment references architecture doc Section 6
- [ ] PR follows pr-format standard

## References

- Architecture doc: Section 6 — Memory Architecture
- Related ADRs: *(ADR for memory backend, once written)*

## Labels

- Type: `feat`
- Scope: `memory`
```

## Rules

- Every issue must have a Problem Statement and Acceptance Criteria before work starts.
- Acceptance criteria must be checkboxes — if you can't write a checkbox for it, the requirement is not concrete enough.
- The References section is required. Trace every issue to at least an architecture doc section.
- Do not assign an issue to yourself until you are actively working on it.
- If the scope changes during implementation, update the issue — don't let it drift from reality.
