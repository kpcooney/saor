# 005 — Targeted Re-Review Pattern for the Review Assistance Protocol

**Status**: proposed

## Context

[ADR-004](004-review-assistance-protocol.md) defined the review assistance protocol as a one-shot operation: Kevin invokes `/review-branch`, three blind reviewer agents produce reports, the coordinator synthesises convergence and divergence, Kevin reads it and decides what to fix. The ADR did not specify what happens *after* the chosen fixes are applied — whether the protocol should re-evaluate the changes, and if so, how.

This gap surfaced in practice on [PR #26](https://github.com/kpcooney/saor/pull/26) (the SQLite memory store). After the protocol's initial run flagged convergent concerns and inline fixes were committed, the natural question was "did the fixes actually address the concerns the reviewers raised?" — and the protocol had no defined answer. The default reflex was to simply re-run `/review-branch` blind on the post-fix branch and check whether the prior concerns reappeared. A short discussion identified that this approach has structural problems serious enough to warrant a deliberate alternative.

The forces at play:

1. **LLM output is non-deterministic.** Two blind runs of the same reviewer prompt against the same code produce slightly different concerns. "The prior concern did not reappear" is not reliable evidence that the fix landed — the reviewer may simply have focused on different aspects of the diff this time. Absence of a concern in run two does not falsify its presence in run one.
2. **A full re-review wastes attention on unchanged code.** Re-reviewing a 1000-line diff to verify a 50-line fix means the reviewer spends most of its budget on parts of the code that did not change. The signal-to-noise ratio of the second run is worse than the first.
3. **Generic re-runs do not converge.** Each blind re-review produces a slightly different set of concerns. Without a structured "is this addressed?" question, the protocol becomes a stochastic source of opinions rather than a verification step.
4. **The protocol's value depends on focused signal.** ADR-004 chose convergence and divergence as the coordinator's job specifically because they are robust against single-reviewer noise. The re-review step should preserve that property.

The decision needs to be made now because the project will accumulate review/fix cycles as Phase 1 implementation proceeds. Without a defined re-review pattern, every PR's fix loop risks either (a) skipping verification entirely (the path of least resistance) or (b) generating noise via ad-hoc blind re-runs.

## Decision

**Options considered:**

- **Option A: No re-review.** Author and human verify fixes informally by reading the diff. The protocol stops at the initial synthesis. Status quo per ADR-004 as written.

- **Option B: Blind full re-review.** Re-run `/review-branch` against the post-fix branch with no prior context. Compare the new synthesis to the old. Treat absence of a prior concern as evidence the fix landed.

- **Option C: Targeted stateful re-review.** Each reviewer in the re-review pass receives their **prior concerns** (the ones they personally raised) and the **diff of the fix** (changes since the last review), with the original full diff available as background context. Their task changes from "review this code" to **"for each prior concern, was it addressed by these changes?"** — emitting a structured verdict per concern (Addressed / Partially addressed / Not addressed / No longer applicable) plus a small section for any new concerns the fix itself introduced. The coordinator then synthesises the verdicts across reviewers.

**Chosen approach**: Option C — targeted stateful re-review. It is the only option that produces deterministic, focused signal on the verification question. Option A leaves the loop unclosed and pushes verification entirely onto the human. Option B produces noisy output for the reasons in Context. Option C trades a small amount of state management for a structured "did the fix work?" answer that scales as the project accumulates fix cycles.

### Re-reviewer task and output

Each reviewer in re-review mode receives:

1. **Their prior concerns** (just the ones they personally raised in the most recent review of this branch — keeps the axes independent and the task scoped).
2. **The diff of the fix** — `git diff <last-reviewed-commit>..HEAD` — what the author changed in response to the prior concerns.
3. **The original full diff** as background, for re-reading the prior context if needed.
4. **Project context** as in the initial review (CLAUDE.md, architecture doc pointer).

The reviewer's task changes from "discover concerns" to "verify resolution". For each prior concern, emit:

- **Verdict**: `Addressed` / `Partially addressed` / `Not addressed` / `No longer applicable`
- **Evidence**: the specific change(s) in the fix diff that support the verdict, by file and line where possible
- **Reasoning**: one or two sentences on why the fix does or does not resolve the concern

In addition, each reviewer emits a small **New concerns** section flagging any issues the fix itself introduced. This guards against regressions without requiring a full re-review of the unchanged code. New concerns use the same severity scheme as the initial review (Blocking / Suggestion / Nit).

### Coordinator's role in re-review

The coordinator's job in re-review is **verdict synthesis**, not concern synthesis. It produces:

- **Resolution status across reviewers** — for each prior concern, the per-reviewer verdicts (a concern raised by one reviewer has one verdict; a convergent concern has two or three). Disagreements between reviewers on whether something was addressed are surfaced explicitly.
- **New convergent concerns from the fix** — any new issues the fix introduced that two or more reviewers flagged.
- **Outstanding work** — concerns marked Not addressed or Partially addressed across reviewers, ranked.

The coordinator does not issue a verdict in re-review either. It does not say "the fix is good" or "the fix is incomplete." It surfaces the structured verdicts and lets Kevin decide whether the loop is closed or another fix iteration is needed.

### Bias mitigation

Reviewers seeing their own prior concerns may anchor toward "addressed" — the human equivalent is the reviewer who suggested a change being more inclined to think the change worked. Three mitigations:

1. **The task is framed as evaluation, not confirmation.** The prompt says "evaluate whether each prior concern was addressed by the changes," not "confirm that your prior concerns were addressed."
2. **Evidence is required.** Each verdict must cite specific lines in the fix diff. A reviewer who cannot cite a change cannot confidently mark a concern Addressed.
3. **Partial and Not addressed are first-class verdicts**, not edge cases. The prompt explicitly enumerates them and asks the reviewer to use them when the fix does not fully resolve the concern.

### State management

Prior reports persist on disk in a known location so the re-review prompt can find them automatically rather than requiring Kevin to pass file paths. Proposed location: `.claude/review-state/<branch-name>/<timestamp>/` containing the three reviewer reports and the coordinator synthesis from each protocol run. The slash command writes to this location at the end of each run (initial or re-review) and reads from it when invoked in re-review mode.

The exact file naming, retention policy, and slash command syntax (separate command vs. flag) are deferred to the implementation issue — what this ADR locks in is that prior state is persisted on disk and looked up automatically based on branch name.

### Migration path to the agent harness

When the proper agent harness lands (issues #7 and #11), the re-review pattern carries over identically: the prompts, the verdict schema, the coordinator's synthesis structure, and the on-disk state location are all reusable artefacts. Only the spawning mechanism changes (Claude Code Task tool → harness coordinator agent). The state location may move from `.claude/review-state/` to the harness's audit/memory store, but the schema is the same.

## Consequences

**Positive:**

- **The fix loop is closed with structured signal.** "Did the fix work?" has a defined answer per reviewer per prior concern, not a stochastic opinion.
- **Re-review cost scales with the size of the fix, not the size of the original PR.** A 50-line fix gets a focused 50-line re-review.
- **Reviewer independence is preserved.** Each reviewer still operates on its own axis with its own prior concerns. The blind-by-axis property of ADR-004 is maintained.
- **The coordinator's role stays narrow.** Verdict synthesis, like concern synthesis, surfaces convergence and divergence without issuing a verdict of its own.
- **State on disk is reusable by the future harness.** The schema (verdicts per concern, evidence, reasoning) is what changes; the spawning mechanism is what gets replaced.

**Negative / trade-offs:**

- **State management cost.** The slash command must persist reviewer reports to a known location and look them up on re-review. This is more complex than the stateless initial protocol. The trade-off is unavoidable if re-review is to be deterministic.
- **Reviewer bias toward "addressed".** A reviewer evaluating whether their own prior concern is fixed has a small tendency to say yes. Mitigated as above (evaluation framing, evidence requirement, first-class Partial/Not verdicts), but not eliminated. Worth observing in practice and re-tuning the prompt if the bias proves material.
- **The "new concerns from the fix" section is narrower than a full re-review.** A fix that introduces a regression in unchanged code (e.g., breaks a behaviour the original tests didn't cover) may not be caught. This is a deliberate scope cut — full re-review is available if Kevin wants it, but is not the default cadence.
- **Coordinator output schema changes between initial and re-review modes.** Two output formats to maintain. The convergence/divergence framing carries over, so the change is bounded but real.

**Neutral / notable:**

- **No verdict from the coordinator in re-review either.** Outstanding work (Not addressed / Partially addressed concerns) is surfaced; Kevin decides whether to iterate.
- **Re-review of an ADR or pure-documentation PR is not particularly useful.** The pattern is designed for code-review fix cycles. Documentation PRs go through normal human review without the protocol.
- **Reversibility.** If the targeted re-review pattern proves insufficient, falling back to blind full re-review is straightforward — invoke `/review-branch` on the post-fix state without the re-review flag. The state on disk is additive, not load-bearing for the initial protocol.
- **The slash command syntax and file conventions are deferred** to the implementation issue. This ADR commits only to the principles: targeted, stateful, verdict-per-prior-concern, with a "new concerns from the fix" guard.

## References

- Issue: [#27 — Write ADR-005: Targeted re-review pattern](https://github.com/kpcooney/saor/issues/27)
- [ADR-004 — Review Assistance Protocol](004-review-assistance-protocol.md) (the protocol this extends)
- [PR #26 — Memory store implementation](https://github.com/kpcooney/saor/pull/26) (where the re-review gap surfaced in practice)
- Reviewer prompt files: `standards/review-assistance/`
- Slash command: `.claude/commands/review-branch.md`
- Future-work issues: #7 (agent identity), #11 (Code Agent integration) — migration targets
