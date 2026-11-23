# 011 — Branch Scope Enforcement

**Status**: accepted

## Context

`AgentScope.branches` is part of every agent identity (architecture Section 7.2) and reads as a security boundary, but nothing enforced it: the scope hook checked files, tools, and expiry, never branches. The Code Agent's default made it worse — it was scoped to `["main"]`, the one branch the project's own rules say nobody works on directly. `/review-branch` on PR #55 flagged both (issue #58), and asked for a recorded decision: enforce it, or mark it as deferred so it stops reading as active.

The decision was to enforce it, and to let the agent commit its own work. Those two pull in different directions:

- **Committing means writing `.git`.** [ADR-010](010-bash-and-read-confinement.md) left `.git` unwritable to Bash because it is outside the agent's file scope. An agent that can commit needs that opened.
- **An agent that can write `.git` can do far more than commit.** `git checkout main`, `git branch -f main <sha>`, `git update-ref`, or simply writing a ref file all go through the same directory. Branch scope would mean nothing.
- **Git commands cannot be vetted by reading them**, for the same reason ADR-010 rejected parsing shell commands: there are too many ways to say the same thing, and a check that can be talked around is the problem being fixed.

There are two distinct things to enforce, and it helps to keep them apart:

1. *May the agent write at all, right now?* — depends on which branch is checked out.
2. *Can the agent change which branch that is, or alter some other branch?* — depends on what it can do to `.git`.

## Decision

**Options considered:**

- **Option A: Hook check plus `.git` write rules in the OS sandbox** — the scope hook answers question 1 by reading the checked-out branch before every write. The Bash sandbox answers question 2 by making `.git` writable *except* for the specific files that switching or altering a branch must write. Trade-off: relies on which files git writes for which operations.
- **Option B: Hook check only, `.git` stays read-only** — simplest and airtight, since the branch cannot change during a run. Trade-off: the agent cannot commit; a human or a later coordinator commits for it.
- **Option C: Gate git commands in the hook** — allow `git commit`, deny `git checkout` and friends by inspecting the command. Trade-off: unsound for the reason above.
- **Option D: Defer** — annotate the field `TODO(phase-N)` and leave it unenforced. Trade-off: the misleading field stays, and Phase 2 builds on it.

**Chosen approach**: Option A — it enforces the scope and keeps commits, using a layer the agent cannot argue with.

### The hook: may the agent write on this branch?

Before any tool that can change files (`Write`, `Edit`, `MultiEdit`, `NotebookEdit`, `Bash`), the hook reads what the repository has checked out, straight from `.git/HEAD`, and compares it with `scope.branches`:

| Checked out | Result |
|---|---|
| A branch matching a `scope.branches` glob | Allowed |
| A branch matching none | Denied, `scope.violation` audited with the branch and the allowed globs |
| Detached HEAD | Denied — there is no branch to match |
| Branch could not be determined | Denied (fail closed) |
| Project is not a git repository | Not applicable — allowed |

The branch is read at every call, not once at launch, so a human switching branches mid-run is seen at the next write. Reads are never restricted by branch. The repository is located by searching upward from the working directory, as git does, so a shell that has `cd`'d into a subdirectory is not mistaken for "not a repository".

### The sandbox: can the agent leave or alter the branch?

If — and only if — the branch checked out at launch is in scope, the Bash sandbox opens `.git` for writing, minus:

| Denied path in `.git` | What that prevents |
|---|---|
| `HEAD` | Switching branch, or detaching |
| `refs/heads/<every other branch>` | Moving, recreating, or deleting another branch. Includes branches that exist only in `packed-refs`, whose ref file does not exist yet |
| `packed-refs` | Rewriting or dropping a packed branch |
| `refs/tags`, `refs/remotes` | Changing tags or remote-tracking refs |
| `config`, `hooks` | Planting configuration or code that runs later, outside the sandbox |

What remains writable is what a commit needs: the object store, the index, the reflogs, and the current branch's own ref.

If the launch branch is out of scope, detached, or the repository directory is not `<project>/.git` (a linked worktree), `.git` stays unwritable exactly as in ADR-010 — and the hook is denying writes anyway.

Pushing is impossible independently of all this: sandboxed commands have no network (ADR-010) and cannot read the credential stores.

### The default

The Code Agent's default branch scope changes from `["main"]` to the feature branches of its issue: `{issue}/*`, following the project's `{issue-number}/{short-description}` naming. An agent with no issue gets `*/*` — any feature-style branch. Neither matches `main`. An explicit `branches` option still overrides the default.

### How this was checked

- The hook logic is covered by the unit suite.
- The `.git` rules are tested against **real git under the real macOS sandbox** (`agents/tests/sandbox/git-under-sandbox.test.ts`): a temp repository, the rules generated by the production code, and `git` run under `sandbox-exec`. Commit, amend, stash, reset, and merge succeed; `checkout`, `switch`, `symbolic-ref HEAD`, `rebase`, and `update-ref`, `branch -f`, and `branch -D` against other branches — loose and packed — all fail, as do writes to `config` and `hooks`. A negative control runs the same commands unsandboxed.
- That test applies the rules with Seatbelt directly. Whether the SDK applies the same settings the same way in an agent session is part of the live check (`agents/src/verify-bash-sandbox.ts`), which has to be run by hand.

## Consequences

**Positive:**

- **`scope.branches` now means what it says**, and the default no longer points at `main`.
- **The agent can commit its own work** on its feature branch.
- **No git command parsing.** The rules are about files, enforced by the OS.
- **Wrong-branch writes are audited**, with the branch and the allowed scope on the event.

**Negative / trade-offs:**

- **The object store is shared.** An agent allowed to commit can write `.git/objects`, where every branch's history lives. It cannot move another branch, but a destructive command could damage the local repository as a whole. The remote is unaffected.
- **Some git operations stop working for the agent**: anything that has to move `HEAD` (`rebase`, `checkout`, and `switch` were tested and fail) or rewrite `packed-refs`. Commit, amend, stash, reset, and merging another branch into the current one were tested and work.
- **A refused branch switch can leave files changed.** `git checkout <other>` updates in-scope working files before it fails on `HEAD`. The branch does not change; the tree may need `git checkout -- .`.
- **Dependence on git's file layout.** The rules assume the files backend. A repository using the reftable backend stores refs differently and would need different rules; with these, the agent simply could not commit there.
- **Branches created mid-run are not covered.** The per-branch rules are built at launch. A branch another process creates later is not in the deny list. (A branch the agent creates itself is harmless: it cannot check it out.)
- **macOS is where this is verified.** On Linux the SDK uses bubblewrap, which protects paths by mounting over them; denying a ref path that does not exist yet (a packed-only branch) may not hold there. `packed-refs` itself is still denied.

**Neutral / notable:**

- **Linked worktrees get no commit access**, because their repository directory lives outside the project. The hook still enforces the branch check for them.
- **Non-git projects are unaffected.** A project created through the UI is not a repository until someone runs `git init`; branch scope does not apply until then.
- **Both spellings of the project root** (given and symlink-resolved) get the rules, as in ADR-010.
- **No identity schema change.** `AgentScope.branches` keeps its shape; its values are now treated as globs.

## References

- Issue: [#58 — Enforce branch scope, or stop declaring an unenforced one](https://github.com/kpcooney/saor/issues/58)
- Related issues: #56 (Bash and read confinement), #11 (Code Agent), #7 (scope enforcement)
- Surfaced by: `/review-branch` on PR #55
- Related ADRs: [010 — Bash and Read Confinement for Agents](010-bash-and-read-confinement.md)
- Architecture doc: [Section 7.2 — Identity Schema](../architecture/sdlc-agent-architecture-research-v4.md), [Section 7.4 — Scope Enforcement via PreToolUse Hooks](../architecture/sdlc-agent-architecture-research-v4.md)
- Project workflow: [git-workflow.md](../../standards/process-standards/git-workflow.md) (branch naming)
