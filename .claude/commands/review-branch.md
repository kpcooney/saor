---
description: Run the review assistance protocol on the current branch (or one named in $ARGUMENTS) — three blind reviewers + a coordinator synthesise findings.
---

# /review-branch

You are running the **review assistance protocol** defined in [ADR-004](docs/adr/004-review-assistance-protocol.md). The reviewer prompts and the coordinator prompt live at `standards/review-assistance/`.

## Goal

Help Kevin review a branch faster by surfacing concerns from three blind reviewer agents, synthesised by a coordinator that highlights convergence and divergence. The agents are advisory — Kevin remains the merge gate. Your output never recommends "approve" or "block".

## Inputs

- `$ARGUMENTS` — optional branch name. If empty, use the current branch.
- The base branch is `main` (or `origin/main` if local `main` is stale).

## Steps

Follow these in order.

### 1. Gather context

Determine the target branch (`$ARGUMENTS` if non-empty, otherwise the current branch via `git rev-parse --abbrev-ref HEAD`). Then collect:

- **Diff vs main**: `git diff origin/main...<branch>` (use the three-dot form to compute the diff from the merge-base, not the tip).
- **Changed files list**: `git diff --name-only origin/main...<branch>`.
- **PR description, if any**: `gh pr view <branch> --json title,body,number 2>/dev/null` — empty result is fine, it just means no PR is open yet.
- **Branch metadata**: `git log --oneline origin/main..<branch>` for the commits being reviewed.

If the diff is empty (the branch matches `main`), stop and tell Kevin there is nothing to review.

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
- `prompt`: a self-contained briefing that includes:
  1. The full text of the reviewer's role prompt file (read in step 2).
  2. The diff (verbatim, in a fenced code block).
  3. The list of changed files.
  4. The PR description if one was found, otherwise the most recent commit messages on the branch as a stand-in.
  5. The contents of `CLAUDE.md` (or, if too long for the prompt, an instruction to the subagent to read it via the Read tool).
  6. A pointer (path) to `docs/architecture/sdlc-agent-architecture-research-v4.md` and a brief instruction to read sections relevant to the changed files.
  7. An explicit instruction to produce the structured output defined in the reviewer's Output Format section, and nothing else — no preamble, no commentary outside the format.

Do not include any reference to the other two reviewers' axes — keep each review independent.

### 4. Spawn the coordinator

Once all three reviewer Tasks have returned, read `standards/review-assistance/coordinator.md`. Spawn one more Task subagent:

- `subagent_type: "general-purpose"`
- `description`: `"Coordinator synthesis"`
- `prompt`: includes:
  1. The full text of the coordinator prompt file.
  2. The three reviewer reports verbatim, each in its own labeled section (`## Design & Code Quality report`, etc.).
  3. The diff line count (so the coordinator can apply the suspicious-unanimity threshold of 200 lines).
  4. An explicit instruction to produce the structured output defined in the coordinator prompt's Output Format section.

### 5. Present the result to Kevin

Output the coordinator's synthesis directly to Kevin. The coordinator already includes the three raw reviewer reports at the bottom of its output, so a single message with the coordinator's full output is sufficient. Do not add your own summary on top — the coordinator's structure is the answer.

If any reviewer Task failed or returned a malformed report, the coordinator will surface that in its `Reviewer report issues` section. Pass through what the coordinator says rather than narrating it yourself.

## Behavioural Rules

- **Do not adjudicate.** You are the orchestrator, not a fourth reviewer. Do not add concerns the reviewers missed; do not rank concerns differently than the coordinator did; do not recommend a merge decision.
- **Run the reviewers blind.** Never include any reviewer's output in another reviewer's prompt. The coordinator is the only stage that sees all three.
- **Parallel reviewers, sequential coordinator.** The three reviewers go in one message (parallel Task calls). The coordinator runs after all three have returned.
- **Pass through faithfully.** The coordinator's output is the deliverable. Do not paraphrase it, summarise it, or wrap it in your own framing.
