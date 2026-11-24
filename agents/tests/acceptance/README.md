# agents/tests/acceptance/

The TypeScript half of the **acceptance tier** ([ADR-007](../../../docs/adr/007-review-truth-model.md), [ADR-012](../../../docs/adr/012-acceptance-tier-mechanics.md)). Each file is the executable definition of done for one GitHub issue: `issue-NNN-<capability>.acceptance.test.ts`, with a `describe` title that starts `#N`. The files here are the list of issues this half covers. The Rust half is in [`src-tauri/tests/acceptance/`](../../../src-tauri/tests/acceptance/).

Tests here run against real things — a git repository and a JSONL audit file in a temp directory (`support/temp-project.ts`) — and read side effects back from disk. No store, hook or collaborator is mocked; the only double allowed is a spy on `console.error` where the behavior being pinned is that a failure is reported there. Every test pairs the behavior it checks with a negative control, so a hook that blocks everything, or logs everything, cannot pass. The full rules are in [testing-requirements.md](../../../standards/process-standards/testing-requirements.md#acceptance-tests).

`tier-conventions.test.ts` is not an issue's test: it fails when a file in this directory is not named to the convention, because vitest would otherwise skip that file silently.

```bash
npm run test:acceptance                              # this directory
npx vitest run --project acceptance issue-007        # one issue
```
