# 004 — Review Assistance Protocol (Claude-Code-Orchestrated Three-Reviewer Pattern)

**Status**: accepted

## Context

Phase 1 implementation (issues #4–#13) is bottlenecked on Kevin's review capacity. CLAUDE.md establishes the PR review loop as the primary quality gate, and that gate works — but it requires Kevin to read every diff cold, which is slow given his other commitments. The result is finished work sitting on unmerged branches (e.g., the work on `4/memory-audit-stores` for issues #4 and #5) while review queues build up.

Two pressures shape the decision:

1. **Time-to-usable matters.** The project needs to be exercised end-to-end before further architecture refinements are warranted. Sitting on review backlog blocks that.
2. **Review quality cannot drop.** The explicit fear is "Claude agents high-fiving and approving bad code." Any solution that lets LLMs gate merges re-introduces the rubber-stamping risk that human review currently prevents.

The architecture document anticipates agent-driven review through the harness (Section 5's reference-based handoff protocol), but the harness requires #7 (agent identity), #11 (Code Agent integration), the memory MCP server (#8), the reference resolver MCP tool (#9), and the audit hooks (#10) to be in place first. That's a months-long path before any review-time relief.

A lighter mechanism that delivers review acceleration in days — without compromising the merge gate — is needed for the interim.

## Decision

**Options considered:**

- **Option A: Build the proper agent harness first, then layer reviewer agents on top.** Architecturally pure. Defers any review-time relief by months because reviewers cannot exist before #7, #8, #9, #10, and #11 land.

- **Option B: Lightweight CI-gated reviewers via GitHub Actions.** A workflow that calls the `claude` CLI twice with different prompts and gates merge on the combined verdict via a required status check. Delivers automation in days. Re-introduces the rubber-stamping risk (LLMs are now in the merge path), and the resulting code is largely throwaway when migrating to the harness.

- **Option C: Claude-Code-orchestrated advisory reviewer agents.** Kevin invokes a slash command during a Claude Code session. The session spawns three blind reviewer agents in parallel — Design & Code Quality, Security & Edge Cases, Testability & Behavior — followed by a coordinator that synthesises their findings into convergence/divergence themes. The agents are advisory; Kevin reviews the synthesis alongside the diff and remains the merge gate.

**Chosen approach**: Option C — keeps Kevin as the merge gate (eliminates the rubber-stamping risk by structure, not mitigation), accelerates his per-PR review by giving him pre-digested concerns from three angles, requires no CI plumbing or branch-protection changes, and produces artefacts (reviewer prompts, coordinator pattern) that port directly to the agent harness when it lands. Only the spawning mechanism changes during migration.

### Reviewer roles

Three reviewers, each with a distinct axis. The split is chosen so the coordinator's convergence signal is meaningful: a concern raised by two reviewers operating from different perspectives is stronger evidence than two reviewers operating from the same perspective.

1. **Design & Code Quality** — covers architecture fit and craft together, since the two are deeply linked:
   - *Architecture fit*: alignment with the architecture document, scope discipline (no premature abstraction or unrelated cleanup), traceability references (Issue, Epic, related ADRs).
   - *Language best practices*: Rust (clippy-clean, idiomatic error handling via `thiserror`/`Result`, no production `unwrap`), TypeScript (strict mode, interfaces over type aliases for public contracts, no `any`), Svelte (runes syntax, component size limits per CLAUDE.md).
   - *Maintainability*: CLAUDE.md "Code Clarity" rules — meaningful names, low nesting via early returns, complex logic broken into named steps, no clever or terse code.
   - *Documentation*: module-level comments where appropriate, public interface contracts described, non-obvious decisions explained — and equally, no over-documentation per CLAUDE.md's "Code Documentation" rules.

2. **Security & Edge Cases** — input validation at trust boundaries, error handling completeness, concurrency and race conditions, secret handling, OWASP-relevant foot-guns of the language and framework, off-by-one and boundary conditions.

3. **Testability & Behavior** — does the test suite exercise the actual contract or just the implementation shape? Are there missing edge cases the tests do not cover? Is the code structured to be testable (dependency injection, separation of pure logic from I/O)? Does the test naming describe behavior rather than function names per CLAUDE.md?

### Coordinator's role

The coordinator's job is **convergence/divergence synthesis, not verdict.** It does not recommend approve or block. Its output is structured roughly as:

- *Convergent concerns*: what did two or more reviewers flag? These get top billing because cross-perspective agreement is the strongest signal.
- *Single-reviewer concerns*: what did exactly one reviewer raise? Surfaced briefly so Kevin can decide whether to investigate.
- *Suspicious unanimity*: if all three reviewers approved a non-trivial diff with no concerns, this is itself flagged for a second look — unanimous LGTM on substantial changes is a known blindspot pattern.
- *Disagreements*: if reviewers explicitly disagree on a point (one approves, another flags), the disagreement is named so Kevin can adjudicate.

The coordinator never says "I recommend approving this PR." That phrasing is reserved for Kevin.

### Blind review

The three reviewers run in parallel and do not see each other's output. The coordinator runs only after all three reports are complete. This prevents the second and third reviewers from anchoring on the first reviewer's verdict — a known failure mode when LLMs are run sequentially on the same input.

### Migration path to the agent harness

When #7 (agent identity) and #11 (Code Agent integration) land, the reviewer agents migrate from Claude-Code-spawned to harness-spawned. The reviewer prompts in `standards/review-assistance/` are read by the harness via the `standards://` URI scheme without modification. The coordinator pattern carries over identically. Only the spawning mechanism changes — the orchestrating skill is replaced by the harness's coordinator agent invoking the same three reviewer roles. No prompt rewrites, no logic changes.

This means the work captured in this ADR is not throwaway. It is the same review pattern, run on simpler infrastructure during Phase 1.

## Consequences

**Positive:**

- **Rubber-stamping risk eliminated by structure.** No LLM can approve or merge anything. Kevin remains the merge gate. The agents are advisors that compress his review time, not substitutes for his judgment.
- **Time-to-usable in days, not months.** No CI plumbing, no API key secrets, no branch protection rule changes. Just docs, prompts, and a thin orchestration skill.
- **Three-axis coverage stronger than two.** The Testability & Behavior axis was a real gap in earlier two-reviewer proposals. Three reviewers also makes the coordinator's convergence signal more meaningful (a 2-of-3 cross-perspective agreement is stronger than a 1-of-2).
- **Migration path is a port, not a rewrite.** The reviewer prompts and coordinator pattern carry over to the agent harness directly. Only the spawning mechanism changes.
- **Prompts are versioned in the repo.** Reviewer behavior is reviewable, diff-able, and improves with the same PR loop as code. The future harness reads them via the `standards://` URI scheme.

**Negative / trade-offs:**

- **Requires an active Claude Code session.** Reviews happen on demand, not automatically on PR push. If Kevin opens a PR while AFK, no advisory review is generated until the next session. Acceptable for Phase 1 because Kevin is the only PR author and is the consumer of the synthesis — there is no asynchronous reviewer-to-author handoff to disrupt.
- **Cost per review.** Three reviewer calls plus one coordinator call per PR, run against the full diff and relevant context (CLAUDE.md, architecture doc pointer). Acceptable for a single-developer Phase 1 project; will be reassessed if cost becomes material.
- **Coordinator quality is a single point of failure.** A poor coordinator can hide a strong concern from one reviewer behind weaker concerns from the others. Mitigated by including the three raw reviewer reports alongside the synthesis so Kevin can spot-check when the synthesis feels off.
- **Reviewer breadth depth trade-off.** The Design & Code Quality reviewer covers four axes (architecture, language idioms, maintainability, documentation) and could give shallow coverage of each. Mitigated by giving it an explicit checklist in its prompt, organised by axis, so it works through each one systematically rather than producing one general impression.

**Neutral / notable:**

- **Prompt location.** Reviewer and coordinator prompts live at `standards/review-assistance/` so they are versioned, reviewable, and resolvable by the future harness via `standards://review-assistance/<role>`.
- **Invocation.** A slash command (working name `/review-branch`) implemented as a Claude Code skill. Defers detailed mechanics to the implementation issue.
- **No GitHub Actions, no branch protection changes, no API secrets.** This decision intentionally avoids touching CI infrastructure.
- **Authors-cannot-review-themselves rule deferred.** In Phase 1, Kevin is the only PR author and the consumer of the synthesis — the rule is moot. It becomes relevant when Code Agents start producing PRs through the harness, at which point the harness identity layer enforces it.
- **Reversibility.** If Option C proves insufficient, the reviewer prompts and coordinator logic carry over to either Option A (proper harness) or Option B (CI-gated) without rewriting the reviewer specifications themselves.

## References

- Issue: [#20 — Write ADR-004: Review assistance protocol](https://github.com/kpcooney/saor/issues/20)
- CLAUDE.md: Development Workflow (review loop), Code Style, Code Clarity, Code Documentation
- Architecture doc: [Section 5 — Reference-Based Handoff Protocol](../architecture/sdlc-agent-architecture-research-v4.md#5-reference-based-handoff-protocol) (future migration target)
- Related ADRs: [002 — Agent Layer Process Strategy](002-agent-process-strategy.md)
- Future-work issues: [#7 — Agent identity schema](https://github.com/kpcooney/saor/issues/7), [#11 — Single Code Agent integration](https://github.com/kpcooney/saor/issues/11) (migration targets)
