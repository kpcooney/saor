# standards/review-assistance/

Reviewer and coordinator prompts for the **review assistance protocol** described in [ADR-004](../../docs/adr/004-review-assistance-protocol.md), plus the **targeted re-review pattern** described in [ADR-005](../../docs/adr/005-targeted-re-review-pattern.md).

The protocol is invoked by Kevin during a Claude Code session. Two slash commands:

- `/review-branch [branch-or-PR]` — initial review. Three reviewer agents run blind in parallel, then a coordinator synthesises their reports into convergence and divergence themes.
- `/re-review-branch [branch-or-PR]` — post-fix re-review. Reads the most recent prior `/review-branch` run, computes the diff of the fix, asks each reviewer to evaluate (per concern) whether the fix addressed it.

The agents are **advisory** in both modes — Kevin remains the merge gate. They never recommend approve or block.

## Files

### Initial review (ADR-004)

- [`design-and-code-quality.md`](design-and-code-quality.md) — architecture fit, language idioms, maintainability, documentation
- [`security-and-edge-cases.md`](security-and-edge-cases.md) — input validation, error handling, concurrency, secrets, foot-guns
- [`testability-and-behavior.md`](testability-and-behavior.md) — contract coverage, missing edge cases, test structure
- [`coordinator.md`](coordinator.md) — synthesises the three reviewer reports into convergence/divergence

### Re-review (ADR-005)

- [`re-review-design-and-code-quality.md`](re-review-design-and-code-quality.md) — same axis, but evaluates each prior concern for resolution
- [`re-review-security-and-edge-cases.md`](re-review-security-and-edge-cases.md) — same axis, evaluation mode
- [`re-review-testability-and-behavior.md`](re-review-testability-and-behavior.md) — same axis, evaluation mode
- [`re-review-coordinator.md`](re-review-coordinator.md) — synthesises verdicts (Addressed / Partially / Not / No-longer-applicable) per concern across reviewers

## Output contracts

**Initial review reviewers** emit:

- A `Summary` line reporting concern counts by severity and any uncertainty flag
- `Blocking`, `Suggestions`, `Nits` sections (omitted if empty), each with location, concern, and why it matters

The initial coordinator never overrides reviewer severity — it surfaces convergence, divergence, single-reviewer concerns, and suspicious unanimity (all clear on a non-trivial diff).

**Re-review reviewers** emit:

- A `Summary` line reporting verdict counts and new-concern counts
- `Prior concern verdicts` — per concern: verdict (Addressed / Partially addressed / Not addressed / No longer applicable), evidence (file:line in fix diff), reasoning
- `New concerns from the fix` — narrower than a full re-review; only flags issues caused by the fix itself

The re-review coordinator surfaces resolution-status counts per reviewer, outstanding work (Partially / Not addressed across all reviewers), new convergent concerns from the fix, and verdict integrity issues (e.g., `Addressed` without an evidence citation). It never says "ship it" or "iterate" — that's Kevin's call.

## State on disk

The slash commands write each run's reports + coordinator synthesis + `meta.json` to `.claude/review-state/<branch-name>/<timestamp>/`. The directory is gitignored — this state is per-developer and regenerable. `/re-review-branch` reads the most recent run's state to identify the prior commit and load the prior reviewer reports.

## Updating prompts

Prompts go through the normal PR workflow. Treat them as code: a change to a reviewer prompt is a change to the protocol's behaviour, and warrants the same review attention as a code change.

When the agent harness lands (issues #7 and #11), these files are read directly by the harness via the `standards://review-assistance/<role>` URI scheme — no rewrite required, only the spawning mechanism changes. The same applies to the re-review prompts: they will be read by the harness in re-review mode without modification.
