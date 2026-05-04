# standards/review-assistance/

Reviewer and coordinator prompts for the **review assistance protocol** described in [ADR-004](../../docs/adr/004-review-assistance-protocol.md).

The protocol is invoked by Kevin during a Claude Code session via the `/review-branch` slash command. Three reviewer agents run blind in parallel, then a coordinator synthesises their reports into convergence and divergence themes. The agents are **advisory** — Kevin remains the merge gate. They never recommend approve or block.

## Files

- [`design-and-code-quality.md`](design-and-code-quality.md) — architecture fit, language idioms, maintainability, documentation
- [`security-and-edge-cases.md`](security-and-edge-cases.md) — input validation, error handling, concurrency, secrets, foot-guns
- [`testability-and-behavior.md`](testability-and-behavior.md) — contract coverage, missing edge cases, test structure
- [`coordinator.md`](coordinator.md) — synthesises the three reviewer reports into a single document

## Output contract

All three reviewers emit the same structured markdown so the coordinator can compare across them:

- A `Summary` line reporting concern counts by severity and any uncertainty flag
- `Blocking`, `Suggestions`, `Nits` sections (omitted if empty), each with location, concern, and why it matters
- Severity definitions match the existing `pr-format.md` reviewer convention: Blocking, Suggestion, Nit

The coordinator never overrides reviewer severity — it only surfaces convergence (multiple reviewers flagged the same thing), divergence (reviewers explicitly disagreed), single-reviewer concerns, and suspicious unanimity (all clear on a non-trivial diff).

## Updating prompts

Prompts go through the normal PR workflow. Treat them as code: a change to a reviewer prompt is a change to the protocol's behaviour, and warrants the same review attention as a code change.

When the agent harness lands (issues #7 and #11), these files are read directly by the harness via the `standards://review-assistance/<role>` URI scheme — no rewrite required, only the spawning mechanism changes.
