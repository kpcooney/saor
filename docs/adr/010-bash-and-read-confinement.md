# 010 — Bash and Read Confinement for Agents

**Status**: accepted

## Context

An agent's identity declares a file scope (`AgentScope.files`), and the PreToolUse scope-enforcement hook is described — in the code and in the architecture document (Section 7.4) — as the thing that holds the agent to it. In practice the hook checked only the file-mutating tools (`Write`, `Edit`, `MultiEdit`, `NotebookEdit`). The Code Agent is also granted `Bash`, `Read`, `Grep`, and `Glob`, and none of those were path-checked. `/review-branch` on PR #55 flagged the gap from both the Design and Security reviewers (issue #56):

- **Writes through `Bash`.** `echo x > docs/notes.md`, `sed -i …`, or `git checkout …` wrote outside the file scope with no `scope.violation` event.
- **Unconfined reads.** `Read`, `Grep`, and `Glob` could read anything the process could reach — `~/.ssh/id_rsa`, `../../.env`, the developer's `.claude/settings.local.json` — and an agent could then carry it into memory or the audit trail.

The code claimed a boundary it did not enforce. Two things make this more pressing now: the storage bridge (ADR-009) means a launched agent runs for real, and Phase 2 builds more agents on the same scope model.

The forces:

- **A Code Agent without a shell is much less useful.** It cannot build or run tests to check its own work.
- **A shell command cannot be scope-checked by inspection.** Redirections, `tee`, `sed -i`, `cp`, interpreters, `git`, subshells, and `eval` all write files; any parser will miss some.
- **A boundary should be enforced where it cannot be argued with.** Hooks see what the agent *says* it will do. The operating system sees what a process *does*.
- **Reads and writes differ.** An agent legitimately reads widely — other modules, docs, standards — while writing narrowly.

## Decision

**Options considered for Bash:**

- **Option A: Run Bash inside the OS sandbox** — the Claude Agent SDK can execute every command under Seatbelt (macOS) or bubblewrap (Linux), with write and read restrictions supplied as settings. Keeps the shell; enforcement is by the OS. Trade-off: the SDK's sandbox always permits writes under the working directory and restricts within it by deny list only, so the restriction has to be generated from the project tree and has a gap for newly created top-level entries.
- **Option B: Remove Bash from the Code Agent** — airtight and trivial. Trade-off: the agent cannot build or test.
- **Option C: Parse commands in the PreToolUse hook** — block commands whose write targets fall outside scope. Trade-off: unsound by construction; it would recreate exactly the problem this ADR exists to fix, a check that reads as a boundary and is not one.

**Chosen approach**: Option A — it is the only option that keeps the agent able to verify its own work while moving enforcement to a layer the agent cannot talk its way around. Where no OS sandbox is available, the system falls back to Option B rather than running Bash unconfined.

**For reads**, the scope hook now checks `Read`, `Grep`, and `Glob`: the target must be inside the project root and must not be a protected path. No per-agent read allowlist is introduced; the read scope is "the project, minus protected paths" for every agent.

### What is enforced, and by what

| Action | Enforced by | Result when out of bounds |
|---|---|---|
| `Write` / `Edit` outside `scope.files` | Scope hook (unchanged) | Denied before it runs; `scope.violation` audited |
| `Read` / `Grep` / `Glob` naming a path outside the project, or a protected path | Scope hook | Denied before it runs; `scope.violation` audited |
| `Grep` / `Glob` sweeping a directory that *contains* a protected file | SDK `Read(...)` deny rules | File excluded from the search |
| `Bash` writing outside the project | OS sandbox | Operation fails; `scope.violation` audited |
| `Bash` modifying or deleting an existing out-of-scope path, or creating anything inside an existing out-of-scope directory | OS sandbox, via a generated deny list | Operation fails; `scope.violation` audited |
| `Bash` reading a protected path | OS sandbox | Operation fails |
| `Bash` network access | OS sandbox (no domains allowed) | Connection fails |
| `Bash` on a host with no OS sandbox | Scope hook, plus removal from the tool lists | Denied before it runs; `tool.blocked` audited |

The hook rows are covered by the unit suite. The write deny list and the protected-read list are additionally tested against the real macOS sandbox (`agents/tests/sandbox/files-under-sandbox.test.ts`): real shell commands run under `sandbox-exec` with the generated rules, with negative controls. What that cannot show is the part only the SDK does — confining writes to the project as a whole, blocking the network, applying `Read(...)` deny rules, and translating these settings into its own sandbox profile. Observing those requires a real agent session, which is what the live check below is for.

**Protected paths** (`agents/src/sandbox/protected-paths.ts`) are, inside the project: `.env` files, `.claude/settings.local.json`, and `.sdlc/` — the memory database and audit trail, which an agent reaches only through the memory tools that enforce its namespaces. For Bash they also include the usual credential locations under the home directory (`~/.ssh`, `~/.aws`, and similar) and the Claude CLI's own state in `~/.claude` — settings, credentials, other sessions' transcripts — with one exception: `~/.claude/shell-snapshots`, which the CLI sources at the start of every command. A live run with the whole directory denied showed every command printing a permission error for its snapshot.

**The write deny list** is computed when the agent is launched: walk the project tree and deny every entry that is neither inside a writable root nor an ancestor of one. Writable roots are the literal directory prefixes of the file-scope globs, plus a fixed list of build-output directories (`node_modules`, `dist`, `src-tauri/target`, …) so that running a build or a test suite still works.

**Sandbox blocks are audited after the fact.** A sandboxed command is allowed to start and the OS stops the individual operation, so a PostToolUse hook inspects the command's result and records a `scope.violation` event tied to the same `toolUseId`. It accepts two kinds of evidence. The SDK's own violation report (a `<sandbox_violations>` block) is authoritative but, as a live run showed, usually absent — five blocked operations produced none. The likely reason is timing: on macOS the SDK learns of violations from the system log, which can lag behind a command that fails quickly. So the hook also recognizes the error a denied operation makes the command print — "operation not permitted" on macOS (in either capitalization: zsh reports it in lowercase), "read-only file system" on Linux, and git's "couldn't set 'HEAD'" when it is refused a ref. That is an inference, and the event records which evidence it rests on (`details.detection`) and words its reason accordingly.

### Known limits

These are stated in the module headers as well, so the code no longer claims more than it does.

1. **New top-level entries.** The deny list is built from what exists at launch. A Bash command can still *create* a new file or directory directly in the project root, or directly in a directory that is only an ancestor of a writable root (a new `src-tauri/notes.txt` when only `src-tauri/src/**` is in scope). It cannot touch anything that already existed out of scope.
2. **Directory granularity for Bash.** `agents/src/**/*.ts` makes all of `agents/src` writable to Bash. The exact glob still applies to `Write` and `Edit`.
3. **Bash reads are a deny list.** Outside the protected paths, a command can read whatever the user account can, and it inherits the environment variables the agent process was started with. Combined with no network access this limits exfiltration to what the agent can place in memory, the audit trail, or its own output.
4. **`.git` is not writable.** It is outside the Code Agent's file scope, so Bash cannot commit or switch branches. That is consistent with the declared scope, and is the starting point for the branch-scope decision in issue #58.
5. **Violation auditing is mostly inferred.** Most `scope.violation` events for Bash rest on the OS error text rather than a sandbox report, so an unrelated `Operation not permitted` in a command's output would be recorded as a likely sandbox block. In the other direction, a blocked *read* on Linux can surface as `No such file or directory` or `Permission denied`, which are too common to treat as evidence; such a block still fails and still appears in the command's `tool.completed` event, but produces no `scope.violation`.
6. **Linux skips glob rules.** The SDK cannot apply glob patterns to bubblewrap writes; the generated deny list is literal paths for that reason. Protected-path read globs are expanded to existing files at launch on Linux.

## Consequences

**Positive:**

- **The boundary is enforced by the OS.** A Bash write outside the project fails regardless of how the command is phrased.
- **The audit trail records the attempt**, both for denied reads and for sandbox-blocked Bash operations.
- **The audit trail and memory database are protected from the agent** — unreadable and unwritable outside the memory tools.
- **The agent keeps its shell**, with builds and tests working.
- **Fails closed.** No sandbox means no Bash, not unconfined Bash.

**Negative / trade-offs:**

- **A residual write gap** (limit 1). Closing it needs either an SDK sandbox mode that does not auto-allow the working directory, or running the agent with a working directory outside the project — a larger change to how the agent addresses files.
- **Dependence on SDK sandbox behavior.** The settings shape, the `//`-prefixed absolute path convention, and the violation marker are SDK details, verified against `@anthropic-ai/claude-agent-sdk@0.2.58`. An SDK upgrade needs the live check re-run.
- **No network for agent shell commands.** Fetching dependencies from Bash will fail until a domain allowlist is added.
- **Not verifiable in the unit suite.** Tests prove the configuration Saor builds; only a real session proves the OS enforces it. `agents/src/verify-bash-sandbox.ts` is that check, run by hand because it makes real API calls.

**Neutral / notable:**

- **No change to the identity schema.** `AgentScope` is untouched; read scope is uniform and the build-output directories are a module constant. A per-agent read scope can be added later if an agent needs to be narrower.
- **`scope.branches` is still unenforced** — tracked by issue #58, which builds on limit 4.
- **Windows** has no supported sandbox, so agents there run without Bash.

## References

- Issue: [#56 — Extend scope enforcement beyond file-mutating tools](https://github.com/kpcooney/saor/issues/56)
- Related issues: #58 (branch scope), #11 (Code Agent), #7 (scope enforcement)
- Surfaced by: `/review-branch` on PR #55
- Related ADRs: [006 — Tool Audit Hook Split](006-tool-audit-hook-split.md), [009 — Agent Storage Bridge Transport](009-agent-storage-bridge-transport.md)
- Architecture doc: [Section 7.4 — Scope Enforcement via PreToolUse Hooks](../architecture/sdlc-agent-architecture-research-v4.md), [Section 7.2 — Identity Schema](../architecture/sdlc-agent-architecture-research-v4.md)
