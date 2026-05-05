---
description: Run the review assistance protocol on a branch or PR — three blind reviewers + a coordinator synthesise findings. Pass a branch name or a PR number, or omit to use the current branch.
---

# /review-branch

You are running the **review assistance protocol** defined in [ADR-004](docs/adr/004-review-assistance-protocol.md). The reviewer prompts and the coordinator prompt live at `standards/review-assistance/`.

## Goal

Help Kevin review a branch faster by surfacing concerns from three blind reviewer agents, synthesised by a coordinator that highlights convergence and divergence. The agents are advisory — Kevin remains the merge gate. Your output never recommends "approve" or "block".

## Inputs

`$ARGUMENTS` is one of:

- **Empty** — use the current branch (`git rev-parse --abbrev-ref HEAD`).
- **A branch name** (anything non-numeric) — use it directly.
- **A PR number** (purely digits, e.g. `23`) — resolve to its head branch via `gh pr view <num> --json headRefName,body,number,title`. The PR description is captured as a side-effect of the resolution and reused in step 1's PR-description step.

The base branch is `main` (or `origin/main` if local `main` is stale).

## Steps

Follow these in order.

### 1. Gather context

Resolve `$ARGUMENTS` to a branch name per the Inputs table:

- If `$ARGUMENTS` is empty, the branch is `git rev-parse --abbrev-ref HEAD`.
- If `$ARGUMENTS` matches `^[0-9]+$`, treat it as a PR number: run `gh pr view <num> --json headRefName,body,number,title > /tmp/saor-review-pr.json` and read `headRefName` from that JSON to get the branch. Fetch first if needed (`git fetch origin pull/<num>/head`).
- Otherwise, treat `$ARGUMENTS` as a branch name directly.

Then collect, **writing each artefact to a temp file** so it can be passed to subagents by path rather than inlined into Task prompts (inlining 1000+ lines into a Task prompt risks hitting input size limits):

- **Diff vs main**: `git diff origin/main...<branch> > /tmp/saor-review-diff.txt` (use the three-dot form to compute the diff from the merge-base, not the tip).
- **Changed files list**: `git diff --name-only origin/main...<branch> > /tmp/saor-review-files.txt`.
- **Branch metadata**: `git log --format='%h %s%n%n%b' origin/main..<branch> > /tmp/saor-review-commits.txt` for the commits being reviewed.
- **PR description**: if `$ARGUMENTS` was a PR number, `/tmp/saor-review-pr.json` was already written above. Otherwise, try `gh pr view <branch> --json title,body,number > /tmp/saor-review-pr.json 2>/dev/null` — non-zero exit is fine, it just means no PR is open for this branch yet.
- **Commit SHA at review time**: `git rev-parse <branch>` — capture the SHA of the branch tip. Hold this for step 5 (state persistence). Re-review later uses this SHA to compute the fix diff (`<this-sha>..HEAD`).

If the diff file is empty (the branch matches `main`), stop and tell Kevin there is nothing to review.

### 2. Read the reviewer prompts

Read each of the three reviewer prompt files. You will pass the contents to each Task subagent so they have their full role definition.

- `standards/review-assistance/design-and-code-quality.md`
- `standards/review-assistance/security-and-edge-cases.md`
- `standards/review-assistance/testability-and-behavior.md`

### 3. Spawn the three reviewers in parallel

Use the Task tool. Send all three calls in a single message so they run concurrently. Each reviewer must run **blind** — its prompt must not contain the other reviewers' output.

For each reviewer, use:

- `subagent_type: "general-purpose"`
- `description`: short — `"Design & Code Quality review"`, `"Security & Edge Cases review"`, `"Testability & Behavior review"`.
- `prompt`: a compact briefing that points the subagent at files to read, rather than inlining content. The subagent has the Read tool. Include:
  1. The path to the reviewer's role prompt file (`standards/review-assistance/<role>.md`) with an instruction to read it in full and follow its Output Format strictly.
  2. The path to the diff file (`/tmp/saor-review-diff.txt`) and the changed-files list (`/tmp/saor-review-files.txt`).
  3. The path to the commits file (`/tmp/saor-review-commits.txt`), and to the PR description JSON (`/tmp/saor-review-pr.json`) if it was created in step 1.
  4. An instruction to read `CLAUDE.md` for project rules.
  5. The path `docs/architecture/sdlc-agent-architecture-research-v4.md` with an instruction to read sections relevant to the changed files (named explicitly when the touched modules are obvious — e.g. Section 6 for memory, Section 8 for audit).
  6. The repo root path (the working directory).
  7. An explicit instruction to begin its response with the heading from its role file's Output Format and produce only that structured output.

Keep the briefing short — two or three hundred words is plenty. The reviewer's role file carries the substance.

Do not include any reference to the other two reviewers' axes — keep each review independent.

### 4. Spawn the coordinator

Once all three reviewer Tasks have returned, **write each report to its own temp file**:

- `/tmp/saor-review-report-1-design.md`
- `/tmp/saor-review-report-2-security.md`
- `/tmp/saor-review-report-3-testability.md`

Then spawn one more Task subagent:

- `subagent_type: "general-purpose"`
- `description`: `"Coordinator synthesis"`
- `prompt`: a compact briefing pointing at:
  1. The path `standards/review-assistance/coordinator.md` with an instruction to read it and follow its Output Format strictly.
  2. The three report file paths above.
  3. The diff line count (compute via `wc -l /tmp/saor-review-diff.txt`) so the coordinator can apply the suspicious-unanimity threshold of 200 lines.
  4. An explicit instruction to begin its response with `# Review Synthesis` and produce only the structured output (no preamble), and to include the three raw reviewer reports verbatim under the `## Raw reviewer reports` section as the coordinator prompt requires.

### 5. Persist run state for future re-review

Before presenting the synthesis to Kevin, persist the run to `.claude/review-state/<branch-name>/<timestamp>/` so a future `/re-review-branch` invocation can read the prior reports and compute the fix diff. Branch names containing slashes (e.g., `4/sqlite-memory-store`) create nested directories — that is intended.

- Compute a filesystem-safe timestamp: `date -u +%Y%m%dT%H%M%SZ` (compact, sortable, no colons).
- Create the directory: `mkdir -p .claude/review-state/<branch>/<timestamp>/`.
- Copy the three reviewer reports and the coordinator synthesis into the directory:
  - `report-1-design.md` (from `/tmp/saor-review-report-1-design.md`)
  - `report-2-security.md` (from `/tmp/saor-review-report-2-security.md`)
  - `report-3-testability.md` (from `/tmp/saor-review-report-3-testability.md`)
  - `synthesis.md` — the coordinator's full output captured in step 4
- Write `meta.json` with this schema:
  ```json
  {
    "branch": "<branch-name>",
    "commit_sha": "<sha-from-step-1>",
    "timestamp": "<iso-8601>",
    "run_mode": "initial"
  }
  ```

`.claude/review-state/` is gitignored — this state is per-developer and regenerable.

### 6. Present the result to Kevin

Output the coordinator's synthesis directly to Kevin. The coordinator already includes the three raw reviewer reports at the bottom of its output, so a single message with the coordinator's full output is sufficient. Do not add your own summary on top — the coordinator's structure is the answer.

If any reviewer Task failed or returned a malformed report, the coordinator will surface that in its `Reviewer report issues` section. Pass through what the coordinator says rather than narrating it yourself.

## Behavioural Rules

- **Do not adjudicate.** You are the orchestrator, not a fourth reviewer. Do not add concerns the reviewers missed; do not rank concerns differently than the coordinator did; do not recommend a merge decision.
- **Run the reviewers blind.** Never include any reviewer's output in another reviewer's prompt. The coordinator is the only stage that sees all three.
- **Parallel reviewers, sequential coordinator.** The three reviewers go in one message (parallel Task calls). The coordinator runs after all three have returned.
- **Pass through faithfully.** The coordinator's output is the deliverable. Do not paraphrase it, summarise it, or wrap it in your own framing.
