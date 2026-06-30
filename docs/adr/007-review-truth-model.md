# 007 — Machine-checked behavioral acceptance as the review authority

**Status**: accepted

**Implementation status**: Adopted as policy. The acceptance tier and mutation testing it
prescribes are **not yet built** — today's gate is the unit suite plus human review (optionally
`/review-branch`). The build-out is tracked by #50 (acceptance tier) and #51 (mutation testing).

## Context

Kevin cannot fluently line-by-line review code across the three Phase 1
languages (Rust, Svelte, TypeScript), and the project's direction is to delegate
implementation to agents rather than have Kevin act as the manual line-level
gate. A review model is therefore needed where the authoritative signal that an
issue is "done" is neither (a) Kevin reading the diff — not feasible across these
languages — nor (b) the agent's own change summary and self-review, which report
intent and carry the author's own blind spots. The goal is an agent-independent
source of truth for whether a capability actually works.

The forces driving the decision:

- Human diff review is not a reliable gate when the reviewer can't fluently read
  the language.
- An agent's change summary / self-review is advocacy, not verification — the
  same lossy-summary problem the architecture already rejects for inter-agent
  handoffs (reference over summary), reappearing at the human-review boundary.
- The review signal must be a fact that a machine checked, not a claim someone
  made.

## Decision

Make **machine-checked behavioral acceptance plus mutation testing** the
authoritative review signal, and demote the agent's summary and self-review to
orientation only.

**Options considered:**

- **Option A — Human line-by-line diff review** (the implicit status quo). Not
  feasible across Rust/Svelte/TypeScript for this reviewer.
- **Option B — Agent summarizes changes and synthesizes its own review; human
  reads the report.** The report is intent, not behavior, and the human can't
  backstop it the way they could backstop a human reviewer's miss.
- **Option C — Machine-checked behavioral acceptance + mutation testing as the
  authority; agent summary/self-review demoted to orientation.**
- **Option D — Multi-agent test generation** (several test-tailored agents
  authoring the test set). More test *authors* widen coverage but do not raise
  the floor on test *quality*; without a deterministic judge it risks agents
  grading agents. Deferred to Phase 2+.

**Chosen approach**: Option C — it makes the source of truth an agent-independent
fact a machine checked (behavior + mutation score), which is the only option
that gives a reliable gate without requiring fluent human diff review.

The chosen model has these specifics:

- A tagged **acceptance tier**, separate from unit tests. Each acceptance test
  maps to a GitHub issue and is the executable definition of done for it.
- Acceptance tests use **real stores** (temp-dir files, in-memory SQLite) and
  verify side effects by reading them back — no mocks at this tier.
- Each acceptance test includes a **negative control**, so a green result can't
  be green for the wrong reason (e.g., a hook that blocks everything must fail
  the in-scope-allowed case).
- **Mutation testing** runs on the load-bearing modules (identity/scope, audit,
  reference resolver, memory store, standards resolution). Mutation score — not
  coverage — is the measure of whether the tests would actually catch a
  regression. It is the judge of test quality.
- **PRs are gated** on the full suite and the mutation score being green before
  they reach Kevin.
- The **PR summary and any agent self-review are orientation only** — they
  indicate where to look; they do not close the issue. The green acceptance run,
  and where applicable the behavior Kevin observes, are what close it.
- Capabilities that touch the **live Claude Agent SDK** (a hook actually firing,
  a tool actually halted) get a small one-time **human-observable integration
  check** in addition to their machine-verifiable acceptance test.

Option D is explicitly out of scope for Phase 1. Revisit it only where the
reasoning approach fundamentally differs (e.g., an adversarial/red-team
perspective distinct from contract-conformance), and only on top of a
deterministic judge — never instead of one.

## Consequences

**Positive:**
- Review becomes runnable, not readable; the source of truth is
  agent-independent and the definition of done is executable.
- Authoring acceptance tests surfaces unspecified contracts early, while they're
  cheap to pin.
- Consistent with the project's existing "reference over summary" and "abstract
  the backends" principles.

**Negative / trade-offs:**
- Mutation testing adds CI time and setup; the acceptance tier is upfront work.
- A green suite proves the harness does what was *specified*, not that the
  *right thing* was specified. Mutation testing mitigates this but does not
  eliminate it, so load-bearing modules still warrant Kevin's eyes at the
  contract/boundary level.

**Neutral / notable:**
- Multi-agent test generation (Option D) is deferred to Phase 2+, gated on a
  deterministic judge existing first.
- The per-issue work — adding a runnable acceptance check with a negative
  control to each of the 13 Phase 1 issues as its definition of done — is a
  separate follow-up; this ADR sets it as the standing policy.

## References

- Initiative: *(n/a)*
- Epic: *(n/a)*
- Issue: #43
- Related ADRs: [001 — Audit Store File Granularity](001-audit-store-scoping.md)
- Architecture doc: [Section 7.4 — Scope Enforcement via PreToolUse Hooks](../architecture/sdlc-agent-architecture-research-v4.md#74-scope-enforcement-via-pretooluse-hooks),
  [Section 8 — Audit Trail](../architecture/sdlc-agent-architecture-research-v4.md#8-audit-trail)
- CLAUDE.md: Testing section (Acceptance tier and where review-truth comes from)
