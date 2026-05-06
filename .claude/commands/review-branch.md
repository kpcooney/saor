---
description: Run the review-assistance protocol on a branch or PR. Default mode is initial review (three blind reviewers + coordinator). Pass --review-fixes to re-review after fixes — each reviewer evaluates only its own prior concerns against the diff of the fix.
---

# /review-branch

You are running the **review-assistance protocol** defined in [ADR-004](docs/adr/004-review-assistance-protocol.md), with the **targeted re-review pattern** from [ADR-005](docs/adr/005-targeted-re-review-pattern.md) available via `--review-fixes`.

## Goal

In both modes, surface concerns from three blind reviewer agents and a coordinator that synthesises their reports. The agents are **advisory** — Kevin remains the merge gate. Your output never recommends "approve" or "block".

- **Initial review** (default): three reviewers discover concerns on the full branch diff.
- **Re-review** (`--review-fixes`): each reviewer evaluates *its own* prior concerns against the diff of the fix, emitting per-concern verdicts (Addressed / Partially addressed / Not addressed / No longer applicable) plus a guard against new concerns the fix introduced.

## Argument parsing

`$ARGUMENTS` is parsed as whitespace-separated tokens. Strip the optional `--review-fixes` flag if present; the remaining token (if any) is the target.

- **No tokens** → mode = `initial`, target = current branch (`git rev-parse --abbrev-ref HEAD`).
- **One token, not `--review-fixes`** → mode = `initial`, target = the token (branch name if non-numeric, PR number if purely digits).
- **`--review-fixes` alone** → mode = `re-review`, target = current branch.
- **`--review-fixes <token>`** → mode = `re-review`, target = the token (branch name or PR number).
- The flag may appear before or after the target (`--review-fixes 26` and `26 --review-fixes` are equivalent).

The base branch is `main` (or `origin/main` if local `main` is stale).

## Mode: initial review

Follow these steps when mode = `initial`.

### 1. Gather context

Resolve the target:

- If target is a branch name, use it directly.
- If target is a PR number (purely digits), run `gh pr view <num> --json headRefName,body,number,title > /tmp/saor-review-pr.json` and read `headRefName` for the branch. Fetch first if needed (`git fetch origin pull/<num>/head`).

Then collect, **writing each artefact to a temp file** so it can be passed to subagents by path rather than inlined into Task prompts (inlining 1000+ lines into a Task prompt risks hitting input size limits):

- **Diff vs main**: `git diff origin/main...<branch> > /tmp/saor-review-diff.txt` (three-dot form: diff from the merge-base).
- **Changed files list**: `git diff --name-only origin/main...<branch> > /tmp/saor-review-files.txt`.
- **Branch metadata**: `git log --format='%h %s%n%n%b' origin/main..<branch> > /tmp/saor-review-commits.txt`.
- **PR description**: if the target was a PR number, `/tmp/saor-review-pr.json` was already written. Otherwise, try `gh pr view <branch> --json title,body,number > /tmp/saor-review-pr.json 2>/dev/null` — non-zero exit is fine.
- **Commit SHA at review time**: `git rev-parse <branch>` — capture for step 5 (state persistence). Re-review later uses this SHA to compute the fix diff.

If the diff file is empty (the branch matches `main`), stop and tell Kevin there is nothing to review.

### 2. Read the reviewer prompts

Read each of the three reviewer prompt files. You will pass the contents to each Task subagent:

- `standards/review-assistance/design-and-code-quality.md`
- `standards/review-assistance/security-and-edge-cases.md`
- `standards/review-assistance/testability-and-behavior.md`

### 3. Spawn the three reviewers in parallel

Use the Task tool. Send all three calls in a single message so they run concurrently. Each reviewer must run **blind** — its prompt must not contain the other reviewers' output.

For each reviewer, use:

- `subagent_type: "general-purpose"`
- `description`: short — `"Design & Code Quality review"`, `"Security & Edge Cases review"`, `"Testability & Behavior review"`.
- `prompt`: a compact briefing pointing at files (subagents have the Read tool). Include:
  1. Path to the reviewer's role prompt file with an instruction to read it in full and follow its Output Format strictly.
  2. Path to the diff (`/tmp/saor-review-diff.txt`) and changed-files list (`/tmp/saor-review-files.txt`).
  3. Path to the commits file (`/tmp/saor-review-commits.txt`), and to `/tmp/saor-review-pr.json` if it exists.
  4. Instruction to read `CLAUDE.md`.
  5. Path `docs/architecture/sdlc-agent-architecture-research-v4.md` with an instruction to read sections relevant to the changed files.
  6. The repo root path (working directory).
  7. Explicit instruction to begin its response with the heading from its role file's Output Format and produce only that structured output.

Keep the briefing short — two or three hundred words. The reviewer's role file carries the substance.

Do not include any reference to the other two reviewers' axes — keep each review independent.

### 4. Spawn the coordinator

Once all three reviewer Tasks have returned, write each report to its own temp file:

- `/tmp/saor-review-report-1-design.md`
- `/tmp/saor-review-report-2-security.md`
- `/tmp/saor-review-report-3-testability.md`

Then spawn one more Task subagent:

- `subagent_type: "general-purpose"`
- `description`: `"Coordinator synthesis"`
- `prompt`: a compact briefing pointing at:
  1. Path `standards/review-assistance/coordinator.md` with an instruction to read it and follow its Output Format strictly.
  2. The three report file paths above.
  3. Diff line count (`wc -l /tmp/saor-review-diff.txt`) so the coordinator can apply the suspicious-unanimity threshold of 200 lines.
  4. Explicit instruction to begin its response with `# Review Synthesis` and produce only the structured output, including the three raw reviewer reports verbatim under `## Raw reviewer reports`.

### 5. Persist run state and prune to the most recent 5 runs

Persist the run to `.claude/review-state/<branch-name>/<timestamp>/` so a future `--review-fixes` invocation can read the prior reports and compute the fix diff. Branch names containing slashes (e.g., `4/sqlite-memory-store`) create nested directories — that is intended.

- Filesystem-safe timestamp: `date -u +%Y%m%dT%H%M%SZ` (compact, sortable, no colons).
- Create the directory: `mkdir -p .claude/review-state/<branch>/<timestamp>/`.
- Copy reviewer reports and the coordinator synthesis:
  - `report-1-design.md` (from `/tmp/saor-review-report-1-design.md`)
  - `report-2-security.md` (from `/tmp/saor-review-report-2-security.md`)
  - `report-3-testability.md` (from `/tmp/saor-review-report-3-testability.md`)
  - `synthesis.md` — coordinator's full output captured in step 4
- Write `meta.json`:
  ```json
  {
    "branch": "<branch-name>",
    "commit_sha": "<sha-from-step-1>",
    "timestamp": "<iso-8601>",
    "run_mode": "initial"
  }
  ```

**Then prune** old runs for this branch, keeping only the 5 most recent timestamps:

```bash
state_dir=".claude/review-state/<branch>"
ls -1 "$state_dir" | sort -r | tail -n +6 | while read d; do rm -rf "$state_dir/$d"; done
```

`.claude/review-state/` is gitignored — this state is per-developer and regenerable.

### 6. Present the result to Kevin

Output the coordinator's synthesis directly. The coordinator already includes the three raw reviewer reports at the bottom, so a single message with the coordinator's full output is sufficient. Do not add your own summary on top — the coordinator's structure is the answer.

If any reviewer Task failed or returned a malformed report, the coordinator will surface that in its `Reviewer report issues` section. Pass through what the coordinator says rather than narrating it yourself.

## Mode: re-review (`--review-fixes`)

Follow these steps when mode = `re-review`.

### 1. Resolve target and find prior run

Resolve the target to a branch name (same logic as initial mode).

Look up `.claude/review-state/<branch-name>/` for prior runs. Each subdirectory is a timestamped run.

- If the directory does not exist or is empty, stop and tell Kevin there is no prior protocol run for this branch — they should run `/review-branch` (initial mode) first.
- Otherwise, find the **most recent** run by sorting subdirectory names (timestamps are filesystem-safe and lexicographically sortable).
- Read the prior run's `meta.json` to obtain `commit_sha` (the SHA that was reviewed).

### 2. Gather context for the re-review

Compute the fix diff and supporting artefacts, writing each to a temp file:

- **Fix diff**: `git diff <prior-commit-sha>..HEAD > /tmp/saor-rereview-fix-diff.txt`. The changes since the prior run.
- **Original full diff**: `git diff origin/main...<branch> > /tmp/saor-rereview-full-diff.txt`. Context for re-reading unchanged code.
- **Fix commit list**: `git log --format='%h %s%n%n%b' <prior-commit-sha>..HEAD > /tmp/saor-rereview-fix-commits.txt`.
- **Current commit SHA at re-review time**: `git rev-parse <branch>` — capture for step 5.

If `<prior-commit-sha>` equals current HEAD, stop and tell Kevin the branch hasn't changed since the prior run — there is nothing to re-review.

The prior run's reviewer reports are already on disk in `.claude/review-state/<branch>/<latest-timestamp>/` — they will be referenced by path directly when spawning the re-reviewers, no copying needed.

### 3. Spawn the three re-reviewers in parallel

Each re-reviewer must run **blind** (no other reviewer's output) and **axis-isolated** (only its own prior concerns).

For each re-reviewer, use:

- `subagent_type: "general-purpose"`
- `description`: short — `"Design re-review"`, `"Security re-review"`, `"Testability re-review"`.
- `prompt`: a compact briefing pointing at files. Include:
  1. Path to the re-reviewer's role prompt file (`standards/review-assistance/re-review-<role>.md`) with an instruction to read it in full and follow its Output Format strictly.
  2. Path to **its own** prior report (e.g., `.claude/review-state/<branch>/<latest-timestamp>/report-1-design.md` for Design & Code Quality). Do NOT pass the other reviewers' reports — axis isolation is the point.
  3. Path to the fix diff (`/tmp/saor-rereview-fix-diff.txt`).
  4. Path to the original full diff (`/tmp/saor-rereview-full-diff.txt`) — context only.
  5. Path to the fix commits file (`/tmp/saor-rereview-fix-commits.txt`).
  6. Instruction to read `CLAUDE.md`.
  7. Path `docs/architecture/sdlc-agent-architecture-research-v4.md` with an instruction to read sections relevant to the changed files.
  8. Explicit instruction to begin its response with the heading from its role file's Output Format and produce only that structured output.

### 4. Spawn the re-coordinator

Once all three re-reviewer Tasks have returned, write each report to a temp file:

- `/tmp/saor-rereview-report-1-design.md`
- `/tmp/saor-rereview-report-2-security.md`
- `/tmp/saor-rereview-report-3-testability.md`

Then spawn one more Task subagent:

- `subagent_type: "general-purpose"`
- `description`: `"Re-review coordinator synthesis"`
- `prompt`: pointing at:
  1. Path `standards/review-assistance/re-review-coordinator.md` with an instruction to read it and follow its Output Format strictly.
  2. The three re-reviewer report file paths above.
  3. Path to the fix diff (`/tmp/saor-rereview-fix-diff.txt`).
  4. Explicit instruction to begin its response with `# Re-Review Synthesis` and produce only the structured output, including the three raw re-reviewer reports verbatim under `## Raw re-reviewer reports`.

### 5. Persist the re-review run and prune

Persist the new run alongside the prior run(s):

- Filesystem-safe timestamp: `date -u +%Y%m%dT%H%M%SZ`.
- Create the directory: `mkdir -p .claude/review-state/<branch>/<timestamp>/`.
- Copy the three re-reviewer reports and the synthesis:
  - `report-1-design.md`
  - `report-2-security.md`
  - `report-3-testability.md`
  - `synthesis.md` — coordinator's full output captured in step 4
- Write `meta.json`:
  ```json
  {
    "branch": "<branch-name>",
    "commit_sha": "<current-sha-from-step-2>",
    "timestamp": "<iso-8601>",
    "run_mode": "re-review",
    "prior_run_commit_sha": "<sha-from-meta-of-prior-run>"
  }
  ```

**Then prune** to the most recent 5 runs (same shell as initial mode):

```bash
state_dir=".claude/review-state/<branch>"
ls -1 "$state_dir" | sort -r | tail -n +6 | while read d; do rm -rf "$state_dir/$d"; done
```

### 6. Present the result to Kevin

Output the re-coordinator's synthesis directly. It already includes the three raw re-reviewer reports at the bottom. Do not add your own summary on top.

If any re-reviewer Task failed or returned a malformed report, the coordinator will surface that in its `Re-reviewer report issues` section. Pass through what the coordinator says rather than narrating it yourself.

## Behavioural Rules (both modes)

- **Do not adjudicate.** You are the orchestrator, not a fourth reviewer. Do not add concerns the reviewers missed; do not rank concerns differently than the coordinator did; do not recommend a merge decision.
- **Run the reviewers blind.** Never include any reviewer's output in another reviewer's prompt. The coordinator is the only stage that sees all three.
- **Re-review is axis-isolated.** Each re-reviewer sees only its own prior concerns. Do not pass other reviewers' reports — the whole point is to evaluate concerns within the same axis that originated them.
- **Parallel reviewers, sequential coordinator.** The three reviewers go in one message (parallel Task calls). The coordinator runs after all three have returned.
- **Pass through faithfully.** The coordinator's output is the deliverable. Do not paraphrase it, summarise it, or wrap it in your own framing.
