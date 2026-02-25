# Code Review Standard

Code review is the quality gate for all changes. Every PR must be reviewed and approved before merging. Kevin merges — authors do not merge their own PRs.

## What Reviewers Check

### Correctness
- Does the implementation match the acceptance criteria in the linked issue?
- Are edge cases handled (empty input, missing files, expired credentials, concurrent access)?
- Does error handling cover the failure modes that can realistically occur?
- Are there logic bugs, off-by-one errors, or incorrect assumptions?

### Test Coverage
- Are there tests for the new behavior?
- Do the tests actually verify the behavior (not just exercise the code path)?
- Are failure cases tested, not just the happy path?
- Do tests use real backends where the testing standard requires it (storage, file I/O)?

### Readability
- Can a reader unfamiliar with the module understand what the code does?
- Are names descriptive? (`resolveStandardWithOverrideChain`, not `resolve`)
- Is complex logic broken into named steps?
- Are non-obvious decisions explained in comments?

### Documentation
- Does every file have a module-level comment?
- Do exported functions and types have doc comments describing their contract?
- Are architecture doc sections or ADRs referenced where the code implements a described decision?

### Standards Adherence
- TypeScript: strict mode, explicit return types, prefer interfaces, typed errors
- Rust: `thiserror` for library errors, no `.unwrap()` in non-test code, `clippy` clean
- Commits: Conventional Commits format
- PR description: follows pr-format standard

### Security
- Does new file system access validate paths against agent scope?
- Do new SQL queries use parameterized statements (no string concatenation)?
- Does subprocess spawning validate inputs?

### Unnecessary Complexity
- Is there abstraction that serves no current purpose?
- Could a simpler approach achieve the same result?
- Is the architecture doc's guidance being followed (no summary-based handoffs, no cloud dependencies in Phase 1)?

## How to Give Feedback

**Distinguish blocking from advisory:**
- Prefix blocking issues with **Blocking:** — the PR cannot merge until these are resolved.
- Prefix suggestions with **Suggestion:** or **Nit:** — the author can address or decline with a response.

**Be specific:**
- Quote the relevant code in your comment.
- Explain *why* it's a problem, not just that it is.
- Suggest the alternative when you have one.

**Blocking:**  The `keyword_search` function builds its SQL query with string concatenation (`format!("... WHERE content MATCH '{query}'")`). This is a SQL injection vulnerability — use a parameterized query with `?` placeholder.

**Suggestion:** Consider extracting the three-tier resolution logic into a named function (`resolveStandardWithOverrideChain`) — it would make the intent of this block clearer and easier to test independently.

## Approval Criteria

Approve when:
- All **Blocking** issues are resolved
- Tests pass (verified via CI or local run mentioned in PR)
- At least one approval from a human reviewer

Do not approve if:
- Tests are failing
- A blocking issue was raised but not addressed or discussed
- The PR description does not reference the issue it closes
