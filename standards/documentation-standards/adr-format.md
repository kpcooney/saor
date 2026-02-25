# ADR Format Standard

Architectural Decision Records capture significant decisions made during design and development. Use this format for every ADR in `docs/adr/`. ADRs go through the normal PR workflow — branch, write, open PR, Kevin merges.

## File Naming

`NNN-short-title.md` — zero-padded three-digit sequence number, hyphenated title. The title describes the *decision being made*, not the outcome.

- `001-audit-store-scoping.md` ✓
- `001-use-jsonl-for-audit.md` ✗ (describes the outcome, not the question)

## Template

```markdown
# NNN — Title (short noun phrase describing the decision)

**Status**: proposed | accepted | deprecated | superseded by [NNN-title](NNN-title.md)

## Context

What is the situation motivating this decision? Describe the forces at play: technical
constraints, project requirements, trade-offs that need resolving. Be specific about
why this decision needs to be made now.

## Decision

What is the change being proposed or adopted? State it directly.

**Options considered:**

- **Option A** — brief description and key trade-off
- **Option B** — brief description and key trade-off

**Chosen approach**: Option X — one sentence explaining why it won.

## Consequences

**Positive:**
- What becomes easier or better

**Negative / trade-offs:**
- What becomes harder or is sacrificed

**Neutral / notable:**
- Constraints or follow-on decisions this creates

## References

- Initiative: *(tracker reference, if applicable)*
- Epic: *(tracker reference, if applicable)*
- Issue: *(tracker reference, if applicable)*
- Related ADRs: *(links to ADRs this decision relates to or supersedes)*
- Architecture doc: *(link to relevant section)*
```

## Example

```markdown
# 001 — Audit Store File Granularity

**Status**: accepted

## Context

The JSONL audit store needs a file-naming strategy. Two options: one file per project
session (granularity matches an agent run) or one file per calendar day (granularity
matches human review cycles). The choice affects how easy it is to grep for events from
a specific run vs. events from a specific day, and how many open file handles we hold.

## Decision

**Options considered:**

- **Per-session** — one JSONL file per agent session ID. Easy to grep all events from
  one run. Proliferates many small files on long-running projects.
- **Per-day** — one JSONL file per calendar day. Easy to review "what happened today".
  Multiple sessions' events are interleaved; session ID field disambiguates them.

**Chosen approach**: Per-day — aligns with human review patterns, reduces file count,
and session ID in every event provides per-session filtering when needed.

## Consequences

**Positive:**
- Predictable file count (one per active day)
- Easy to open and grep recent history

**Negative / trade-offs:**
- Extracting a single session's events requires filtering by `sessionId` field

**Neutral / notable:**
- File path pattern: `{project}/.sdlc/audit/YYYY-MM-DD.jsonl`

## References

- Architecture doc: [Section 8.4 — Audit Store Implementations](../../docs/architecture/sdlc-agent-architecture-research-v4.md#84-backend-implementations)
```

## Rules

- Status must be one of the four defined values. Update it when the ADR is accepted (merged) or superseded.
- Write in past tense for Context (what was true when the decision was made) and present tense for Decision and Consequences.
- Keep it short. A good ADR is one to two pages. If you need more, split into multiple decisions.
- The References section is required. Missing traceability links will be flagged in review.
