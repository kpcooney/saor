# 012 — How the acceptance tier is separated, tagged, and run

**Status**: accepted

## Context

[ADR-007](007-review-truth-model.md) adopted a tagged acceptance tier — separate from the unit suite, each test mapped to a GitHub issue, real stores, a negative control per test — as the machine-checked half of "done". It set the policy and left the mechanics open. Issue #50 builds the tier, which forces four choices that a later reader would otherwise have to reverse-engineer:

- **How a test is marked as acceptance.** The project has two test runners (vitest in `agents/`, cargo in `src-tauri/`) and no shared notion of a tag.
- **How a test is tied to its issue.** ADR-007 requires the mapping; nothing said where it lives.
- **What "real store" means in the TypeScript layer**, where the stores themselves are Rust-owned and reached over the storage bridge (ADR-009).
- **What runs the tier.** ADR-004 and ADR-005 chose no CI; issue #50 says adding one is Kevin's call, not something to assume.

## Decision

**Options considered** for marking the tier:

- **Option A — A directory per runner, selected by the runner's own mechanism.** `agents/tests/acceptance/` as a vitest project; `src-tauri/tests/acceptance/` as its own cargo test target. No new dependency, and the tier is visible in the tree.
- **Option B — In-place tags** (`#[ignore]` or a cargo feature in Rust; a name tag filtered with `-t` in vitest). Keeps tests beside the unit tests, but `#[ignore]` means plain `cargo test` silently skips the definition of done, a feature flag splits the build, and a name filter is easy to get wrong without anything failing.
- **Option C — A separate harness** (a new crate or package for acceptance tests). Strongest separation, but a second place to keep dependencies and configuration in step for no extra guarantee.

**Chosen approach**: Option A — it uses what each runner already has, and a test's tier is decided by where the file is, which is hard to get subtly wrong.

The mechanics that follow from it:

- **Location is the tag.** TypeScript acceptance tests live in `agents/tests/acceptance/` and run as the vitest project `acceptance` (the rest of `agents/tests/` is the project `unit`; see `agents/vitest.config.ts`). Rust acceptance tests live in `src-tauri/tests/acceptance/` and build as the cargo test target `acceptance`.
- **The file name carries the issue.** One file per issue: `issue-NNN-<capability>.acceptance.test.ts` and `issue_NNN_<capability>.rs`, zero-padded to three digits. The vitest `describe` title starts with `#N`. A failing test therefore names the issue whose definition of done it broke, and one issue's tests can be run alone (`cargo test --test acceptance issue_004`, `npx vitest run --project acceptance issue-007`).
- **An issue that extends an earlier capability gets its own file.** Branch scope (#58) extends scope enforcement (#7) and lives in `issue-058-…`, not in the #7 file. The test belongs to the issue that promised the behavior, even when the code under test is shared.
- **Each half checks its own wiring.** A file that is in the directory but would not run is the one way location-as-tag fails silently: cargo ignores a `.rs` file that `main.rs` does not declare as a module, and vitest ignores a file not named `*.test.ts`. Each half therefore has one test that lists its directory and fails on a file that is undeclared or misnamed (`every_acceptance_file_is_declared_as_a_module` in `main.rs`; `tier-conventions.test.ts`).
- **A capability is tested in the layer that owns it.** The memory store, audit store and reference resolver are Rust and are tested against SQLite and JSONL files in a temp directory. Identity, scope enforcement and the audit hooks are TypeScript and are tested against a real git repository and a real JSONL audit file on disk, through the `AuditLogger` port. The TypeScript tier does not start the Rust stores; that the two halves agree across the bridge is issue #59's own test (`src-tauri/tests/storage_bridge.rs`).
- **The default commands run everything; the tier is also runnable alone.** `npm test` (in `agents/`) and `cargo test` (in `src-tauri/`) still run the full suite, acceptance included, so the tier cannot be forgotten. `npm run test:acceptance` from the repository root runs the tier across both languages in one command; it runs both halves even when the first fails, and fails if either did.
- **No CI is added.** The tier is run locally, by the author before opening a PR and by anyone checking the PR. Whether to automate the gate stays an open question for Kevin, as issue #50 records.

## Consequences

**Positive:**
- One command answers "is every backfilled issue still done?", and one filter answers it for a single issue.
- No new dependencies or build configurations; the unit suite's commands and locations are unchanged.
- The mapping from test to issue is in the file name, so it shows up in every test report without extra tooling.

**Negative / trade-offs:**
- Acceptance tests for one issue can be split across two directories when the capability spans both languages.
- The wiring checks catch a file that would not run or is misnamed, but not a test filed under the wrong issue — that is still review's job. A filter that matches nothing is also quiet on the Rust side: `cargo test --test acceptance issue_04` runs zero tests and exits 0, where vitest fails with "no test files found".
- Without CI the gate depends on someone running the command. ADR-007's "PRs are gated on the full suite" is, for now, a step in the author's workflow rather than something a machine enforces.

**Neutral / notable:**
- The tier was seeded with the five capabilities issue #50 names, plus #58, whose test would otherwise have sat in the #7 file. Which issues are covered is not listed in any document: the files in the two acceptance directories are the list. The remaining Phase 1 issues get their acceptance files as follow-up work under the same convention; `tests/storage_bridge.rs` already plays that role for #59 and can be moved into the tier when that happens.
- Mutation testing (#51) is unaffected by this decision and will judge these tests once it exists.

## References

- Initiative: *(n/a)*
- Epic: *(n/a)*
- Issue: #50
- Related ADRs: [007 — Machine-checked behavioral acceptance as the review authority](007-review-truth-model.md), [004 — Review assistance protocol](004-review-assistance-protocol.md), [009 — Agent storage bridge transport](009-agent-storage-bridge-transport.md)
- Architecture doc: [Section 7.4 — Scope Enforcement via PreToolUse Hooks](../architecture/sdlc-agent-architecture-research-v4.md#74-scope-enforcement-via-pretooluse-hooks), [Section 8 — Audit Trail](../architecture/sdlc-agent-architecture-research-v4.md#8-audit-trail)
