---
description: Re-review a branch after a fix. Reads the most recent /review-branch run for the branch, computes the diff of the fix, asks each reviewer to verify whether its prior concerns were addressed.
---

# /re-review-branch

You are running the **targeted re-review pattern** defined in [ADR-005](docs/adr/005-targeted-re-review-pattern.md). This is the post-fix verification loop for the review-assistance protocol — it answers "did the fix address the concerns the reviewers raised?" without re-reviewing the entire PR.

## Goal

Help Kevin close the review/fix loop with structured verdicts per prior concern, plus a guard against new issues introduced by the fix. The agents are still **advisory** — Kevin remains the merge gate. Your output never recommends "approve" or "block".

## Inputs

`$ARGUMENTS` is one of (same as `/review-branch`):

- **Empty** — use the current branch (`git rev-parse --abbrev-ref HEAD`).
- **A branch name** — use it directly.
- **A PR number** (purely digits) — resolve via `gh pr view <num> --json headRefName`.

## Steps

Follow these in order.

### 1. Resolve target and find prior run

Resolve `$ARGUMENTS` to a branch name (same logic as `/review-branch`).

Look up `.claude/review-state/<branch-name>/` for prior runs. Each subdirectory is a timestamped run.

- If the directory does not exist or is empty, stop and tell Kevin there is no prior protocol run for this branch — they should run `/review-branch` first.
- Otherwise, find the **most recent** run by sorting subdirectory names (timestamps are filesystem-safe and lexicographically sortable).
- Read the prior run's `meta.json` to obtain `commit_sha` (the SHA that was reviewed).

### 2. Gather context for the re-review

Compute the fix diff and supporting artefacts, writing each to a temp file so subagents can read by path:

- **Fix diff**: `git diff <prior-commit-sha>..HEAD > /tmp/saor-rereview-fix-diff.txt`. This is the changes made *since* the prior run — what we are asking each reviewer to evaluate.
- **Original full diff**: `git diff origin/main...<branch> > /tmp/saor-rereview-full-diff.txt`. For context if a reviewer needs to re-read unchanged code.
- **Fix commit list**: `git log --format='%h %s%n%n%b' <prior-commit-sha>..HEAD > /tmp/saor-rereview-fix-commits.txt`.
- **Current commit SHA at re-review time**: `git rev-parse <branch>` — capture for step 5 (state persistence).

The prior run's reviewer reports are already on disk in `.claude/review-state/<branch>/<latest-timestamp>/` — they will be referenced by path directly when spawning the re-reviewers, no copying needed.

If `<prior-commit-sha>` equals current HEAD, stop and tell Kevin the branch hasn't changed since the prior run — there is nothing to re-review.

### 3. Spawn the three re-reviewers in parallel

Use the Task tool. Send all three calls in a single message so they run concurrently. Each re-reviewer must run **blind** (no other reviewer's output) and **axis-isolated** (only its own prior concerns).

For each re-reviewer, use:

- `subagent_type: "general-purpose"`
- `description`: short — `"Design re-review"`, `"Security re-review"`, `"Testability re-review"`.
- `prompt`: a compact briefing pointing at files. Include:
  1. The path to the re-reviewer's role prompt file (`standards/review-assistance/re-review-<role>.md`) with an instruction to read it in full and follow its Output Format strictly.
  2. The path to **its own** prior report (e.g., `.claude/review-state/<branch>/<latest-timestamp>/report-1-design.md` for Design & Code Quality). Do NOT pass the other reviewers' reports — axis isolation is the point.
  3. The path to the fix diff (`/tmp/saor-rereview-fix-diff.txt`).
  4. The path to the original full diff (`/tmp/saor-rereview-full-diff.txt`) — context only, the re-reviewer reads its prior report and the fix diff first.
  5. The path to the fix commits file (`/tmp/saor-rereview-fix-commits.txt`).
  6. An instruction to read `CLAUDE.md` for project rules.
  7. The path `docs/architecture/sdlc-agent-architecture-research-v4.md` with an instruction to read sections relevant to the changed files.
  8. An explicit instruction to begin its response with the heading from its role file's Output Format and produce only that structured output.

Keep the briefing short — 200-300 words. The role file carries the substance.

### 4. Spawn the re-coordinator

Once all three re-reviewer Tasks have returned, write each report to its own temp file:

- `/tmp/saor-rereview-report-1-design.md`
- `/tmp/saor-rereview-report-2-security.md`
- `/tmp/saor-rereview-report-3-testability.md`

Then spawn one more Task subagent:

- `subagent_type: "general-purpose"`
- `description`: `"Re-review coordinator synthesis"`
- `prompt`: a compact briefing pointing at:
  1. The path `standards/review-assistance/re-review-coordinator.md` with an instruction to read it and follow its Output Format strictly.
  2. The three re-reviewer report file paths above.
  3. The path to the fix diff (`/tmp/saor-rereview-fix-diff.txt`).
  4. An explicit instruction to begin its response with `# Re-Review Synthesis` and produce only the structured output (no preamble), and to include the three raw re-reviewer reports verbatim under `## Raw re-reviewer reports`.

### 5. Persist the re-review run

Persist the new run alongside the prior run(s) so a future re-re-review (rare but possible) can find it.

- Compute a filesystem-safe timestamp: `date -u +%Y%m%dT%H%M%SZ`.
- Create the directory: `mkdir -p .claude/review-state/<branch>/<timestamp>/`.
- Copy the three re-reviewer reports and the synthesis into the directory:
  - `report-1-design.md`
  - `report-2-security.md`
  - `report-3-testability.md`
  - `synthesis.md` — the coordinator's full output captured in step 4
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

### 6. Present the result to Kevin

Output the coordinator's synthesis directly to Kevin. The synthesis already includes the three raw re-reviewer reports at the bottom, so a single message is sufficient. Do not add your own summary on top — the coordinator's structure is the answer.

If any re-reviewer Task failed or returned a malformed report, the coordinator will surface that in its `Re-reviewer report issues` section. Pass through what the coordinator says rather than narrating it yourself.

## Behavioural Rules

- **Axis isolation is non-negotiable.** Each re-reviewer sees only its own prior concerns. Do not pass other reviewers' reports — the whole point is to evaluate concerns within the same axis that originated them.
- **Do not adjudicate verdicts.** You are the orchestrator. Do not change a reviewer's `Partially addressed` to `Addressed` because the change looks fine to you, and do not promote `Suggestion` severity to `Blocking`.
- **Run the re-reviewers blind.** No re-reviewer sees the others' output. The re-coordinator is the only stage that sees all three.
- **Parallel re-reviewers, sequential coordinator.** Same shape as `/review-branch`.
- **Pass through faithfully.** The coordinator's synthesis is the deliverable. Do not paraphrase or wrap it in your own framing.
