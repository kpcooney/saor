# Local Permissions Policy

What an agent may do without asking during local development, and what requires explicit approval. These are **behavioral guidelines** Claude Code follows as instructions — not a runtime sandbox. The runtime allowlist lives in [`.claude/settings.local.json`](../../.claude/settings.local.json); this document is the human-readable policy and rationale behind it.

## Security model

The actual security boundaries are **GitHub branch protection on `main`** and **Kevin reviewing every PR before merge**. These permissions exist to reduce friction for local work — the PR review gate is what prevents bad code from reaching `main`. The PR workflow is the quality gate; local work should flow without prompt-by-prompt permission.

## Allowed without asking

**Git (non-destructive, feature branches only):**
- `git add`, `git commit`
- `git push`, `git push -u origin` — **only to feature branches**, never directly to `main`
- `git branch`, `git checkout`, `git switch`
- `git status`, `git log`, `git diff`, `git fetch`, `git pull`
- `git stash`, `git stash pop`

**Build and test:**
- `npm install`, `npm ci` (in `agents/` or root) — note: this executes postinstall scripts from dependencies; mitigated by package.json changes going through PR review
- `npm test`, `npm run build`, `npm run dev` (in `agents/` or root)
- `cargo build`, `cargo test`, `cargo clippy`, `cargo fmt` (in `src-tauri/`)
- `npx vitest` — only `vitest`; do not run arbitrary packages via `npx`

**File operations:**
- Read, write, edit, create, delete files within the project directory
- Create directories
- **Exception**: do not modify `CLAUDE.md` without explicit approval — it defines the project's operating rules and permission boundaries

## Requires explicit approval

- `git push --force`, `git push --force-with-lease` — destructive, can lose review history
- `git reset --hard` — discards uncommitted work
- `git push` directly to `main` — Kevin merges via GitHub PR
- `git merge` into `main`
- Modifying `CLAUDE.md`
- Any command that deploys, publishes, or releases
- `rm -rf` or bulk deletions outside of normal file editing
- Running arbitrary packages via `npx` (only the whitelisted tools above)
- Any shell command that installs system-level packages or modifies system configuration
- Deleting git branches or removing worktrees
