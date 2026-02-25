# Pull Request Format Standard

PRs are the primary review and merge mechanism. A well-written PR description lets the reviewer understand what changed and why without reading every line of code first.

## When to Open a PR

- Open as **draft** when you want early feedback on direction before the implementation is complete.
- Open as **ready for review** when implementation is complete, tests pass, and lint is clean.
- Do not mark a PR ready for review if you know it has outstanding issues — leave it draft and note what's unresolved.

## Template

```markdown
## Summary

One to two sentences describing what this PR does and why. The reviewer should
understand the change at a glance.

## Changes

What was changed and why. Use bullet points for multiple changes. Be specific about
non-obvious decisions — if you chose approach A over B, say so here. The code shows
*what* changed; this section explains *why*.

- Implemented `SqliteMemoryStore` with FTS5 search (memory/store.rs, memory/fts.rs)
- Added schema migration logic that runs on `initialize()` — idempotent, safe to run
  multiple times
- Chose per-day JSONL file granularity for audit log (see ADR-001)

## Testing

What tests were added or modified. How to run them. What was tested manually if
automated tests don't cover it.

- Unit tests: `cargo test -p saor-lib memory` — covers CRUD, FTS5 search, migration
- Tested manually: opened the app, created a project, verified .sdlc/memory.db was
  created with the correct schema

## References

- Closes #NNN
- Epic: *(tracker reference, if applicable)*
- Related ADRs: *(links)*
- Architecture doc: *(section links)*

## Open Questions

Anything the reviewer should weigh in on — architectural choices, trade-offs you're
unsure about, alternatives you considered and rejected. If none, write "None."

## Checklist

- [ ] Tests added/updated and passing (`cargo test` / `npm test`)
- [ ] Lint clean (`cargo clippy` / `npm run lint`)
- [ ] Module-level documentation updated
- [ ] Follows coding standards for the language(s) modified
- [ ] PR description references the issue being closed
```

## Review Process Rules

**For authors:**
- Do not merge your own PRs. Kevin merges.
- Respond to review comments by pushing new commits. Do not force-push or squash during review — the reviewer needs to see what changed in response to their feedback.
- If a comment is addressed, reply with how you addressed it. If you disagree, explain why — do not silently ignore.
- Keep PRs focused. One feature or fix per PR. If scope grows, open a follow-up issue.

**For reviewers:**
- Approve only when all blocking issues are resolved and tests pass.
- Distinguish blocking issues from suggestions: prefix blocking with "**Blocking:**" and suggestions with "**Suggestion:**" or "**Nit:**".
- Give specific, actionable feedback. "This function is confusing" is not actionable. "This function mixes validation and persistence — consider splitting at line 42" is.

## Example Summary

```markdown
## Summary

Implements the SQLite memory store with FTS5 full-text search, satisfying the Phase 1
memory layer requirement. Agents can now write and search memory entries via the Tauri
IPC commands added in this PR.

## Changes

- Added `SqliteMemoryStore` in `memory/store.rs` with write, read-by-id, and
  keyword-search operations
- Added FTS5 virtual table (`memory_fts`) and trigger-based sync in `memory/schema.rs`
- Schema migration runs on `initialize()` — safe to call multiple times
- Exposed three Tauri commands: `memory_write`, `memory_read`, `memory_search`

## Testing

- `cargo test -p saor-lib memory` — 8 tests, all passing
- Tests use `Connection::open_in_memory()` — no file system setup required

## References

- Closes #12
- Architecture doc: Section 6.3 — SQLite + FTS5 Schema

## Open Questions

None.
```
