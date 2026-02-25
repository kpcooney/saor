# Git Workflow Standard

All development work follows a branch-and-PR model. Work happens on feature branches, reviewed via GitHub pull requests, merged by Kevin. This is the primary autonomy model — implement independently on a branch, open a PR for review rather than seeking prompt-by-prompt approval.

## The Full Cycle

1. **Issue exists** — every branch corresponds to a GitHub issue. If no issue exists for the task, create one first using the issue-format standard. The issue defines scope and acceptance criteria.

2. **Create a branch** from `main`:
   ```
   git checkout main && git pull origin main
   git checkout -b {issue-number}/{short-description}
   ```
   Branch naming: `{issue-number}/{short-description}`. Examples:
   - `12/sqlite-memory-store`
   - `15/jsonl-audit-writer`
   - `18/code-agent-identity`

3. **Implement on the branch.** Commit early and often using Conventional Commits. Each commit should be a coherent, self-contained unit — not one massive commit at the end.

4. **Write tests alongside the code** — not as a separate step after. Tests are part of the implementation, not an afterthought.

5. **Open a PR** when implementation is complete and tests pass. Follow the pr-format standard. Mark as **draft** if it's not yet ready for review; mark as **ready for review** when it is.

6. **Wait for review.** Kevin will leave comments on GitHub. Do not merge while waiting.

7. **Address review comments** by pushing additional commits to the same branch. Do not force-push or squash during review — the reviewer needs to see what changed in response to their feedback.

8. **Kevin merges.** Do not merge your own PRs.

## What Can Be Done Autonomously

No approval needed before doing these:

- Creating feature branches and pushing commits
- Creating GitHub issues for tasks within the current phase scope (Phase 1 deliverables)
- Opening pull requests
- Responding to review comments with code changes
- Creating ADRs for design decisions (they still go through PR review)

## What Requires Discussion First

Stop and ask before doing these:

- **Architecture changes** — anything that modifies the architecture document or core design principles
- **Scope changes** — adding or removing Phase 1 deliverables, or starting Phase 2 work before Phase 1 is complete
- **New dependencies** — adding packages not implied by the architecture (e.g., a new Cargo dependency that isn't `rusqlite`, `thiserror`, `anyhow`, or Tauri; a new npm package that isn't `@anthropic-ai/claude-agent-sdk` or `zod`)
- **Design questions not covered by the architecture doc** — if in doubt about direction, ask rather than guess. It is better to ask than to build on the wrong assumption.

## If You're Unsure

If you encounter a decision that could go multiple ways and the architecture doc doesn't clearly resolve it, stop and ask. The threshold for "write an ADR vs. just ask": if the decision would be hard to reverse, or if a future reader would wonder "why did they do it this way?", it warrants an ADR. If it's a minor implementation detail, make a call and leave a comment explaining why.

## Keeping Branches Clean

- Rebase onto `main` before opening a PR if the branch has diverged significantly.
- Do not commit `.env` files, secrets, generated files that belong in `.gitignore`, or IDE-specific files.
- The `.sdlc/` directory (runtime data — memory DB, audit logs) is gitignored and must never be committed.
