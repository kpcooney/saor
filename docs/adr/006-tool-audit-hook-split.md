# 006 — Where Tool-Call Audit Events Are Emitted

**Status**: accepted

## Context

The audit trail records every tool call as two events: `tool.invoked` (the
attempt) and `tool.completed` (the outcome), per the event schema in
architecture Section 8.2. Issue #10 implements the automatic emission of these
events via hooks.

The initial implementation emitted **both** events from a single PostToolUse
hook: when a tool returned, the hook synthesised a `tool.invoked` event followed
by a `tool.completed` event. Review of PR #42 surfaced two problems with this:

1. **Co-timestamped pairs.** A PostToolUse hook fires only once — after the tool
   returns — so both events were stamped with the same instant. Any consumer
   ordering events by `timestamp` (the JSONL trail is greppable/`jq`-able and the
   future SqliteAuditStore is timestamp-indexed, per Section 8.4) could not
   reconstruct invoked-before-completed ordering. The audit trail's stated
   purpose (Section 8.5) is post-mortem reconstruction of the action chain, which
   a co-timestamped pair degrades.
2. **A fabricated `pending` state.** The synthetic `tool.invoked` event carried
   `result: 'pending'`, but at PostToolUse time the outcome is already known —
   the "pending" instant was never actually observed. The event recorded a state
   that never existed.

Both stem from the same root: a PostToolUse-only hook cannot observe the
"before" moment, so any `tool.invoked` it produces is reconstructed after the
fact. Simply calling the clock twice does not fix this — two back-to-back reads
collide on the same millisecond, and the invoked timestamp would still be
post-hoc.

## Decision

Emit the two events from **two hooks**, each firing at the moment its event
describes:

- `tool.invoked` (`result: 'pending'`) — emitted by a **PreToolUse** hook,
  before the tool runs.
- `tool.completed` (`result: 'success' | 'failure'`) — emitted by a
  **PostToolUse** / **PostToolUseFailure** hook, after the tool returns.

The two events are correlated by `details.toolUseId` — the SDK's tool-use id,
which both hooks receive — since they are no longer written together and can no
longer rely on adjacency to pair them.

**Options considered:**

- **Option A — split across PreToolUse + PostToolUse.** Each event is emitted
  where its timestamp is real and its `result` is truthful; the pair is
  correlated by `toolUseId`. Adds a second hook and a correlation key.
- **Option B — keep both in PostToolUse, fabricate a distinct timestamp.** One
  hook, but the invoked timestamp is invented to look ordered and the `pending`
  state is still never genuinely observed.

**Chosen approach**: Option A — it is the only option that gives the pair
genuinely distinct, correctly-ordered timestamps and keeps each event's `result`
honest, rather than inventing data to paper over a single observation point.

## Consequences

**Positive:**
- `tool.invoked` and `tool.completed` carry distinct, correctly-ordered
  timestamps (the real invocation and completion instants), so timestamp-ordered
  queries reconstruct the action chain correctly.
- `result: 'pending'` on the invoked event is literally true at the moment it is
  recorded.
- Each hook writes exactly one event, so there is no multi-event batch that can
  be left half-written — the prior "partial write leaves a dangling pending"
  concern within a single hook is structurally removed.

**Negative / trade-offs:**
- Two hooks instead of one, and a `toolUseId` correlation key consumers must use
  to pair events (rather than relying on adjacency).
- The invoked and completed events are written at different times by different
  hooks, so a logger failure on the completed write can still leave a `pending`
  event without a recorded completion. This is inherent to any two-phase audit;
  it is surfaced to stderr (auditing is best-effort and never gates the tool
  flow, per CLAUDE.md principle 4).

**Neutral / notable:**
- **Blocked-call interaction.** The PreToolUse audit hook runs alongside the
  scope-enforcement PreToolUse hook (issue #7) and expresses no permission
  opinion (returns an empty result). If scope enforcement blocks a call, the
  tool never runs and no `tool.completed` follows; the scope hook's `tool.blocked`
  event — sharing the same `toolUseId` — records the resolution instead. So a
  `tool.invoked` event is resolved by either a `tool.completed` or a
  `tool.blocked` event, never left dangling by design.
- Hook registration (wiring both hooks into the agent harness) lands with the
  harness work in issues #7/#11; this ADR covers only the emission design.

## References

- Issue: #10 — audit-logging hook
- Related ADRs: [001 — Audit Store File Granularity](001-audit-store-scoping.md)
- Architecture doc: [Section 8 — Audit Trail](../architecture/sdlc-agent-architecture-research-v4.md#8-audit-trail),
  [Section 8.2 — Event Schema](../architecture/sdlc-agent-architecture-research-v4.md#82-event-schema),
  [Section 8.5 — How the Audit Trail Integrates](../architecture/sdlc-agent-architecture-research-v4.md#85-how-the-audit-trail-integrates)
