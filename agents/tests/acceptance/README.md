# agents/tests/acceptance/

The TypeScript half of the **acceptance tier** ([ADR-007](../../../docs/adr/007-review-truth-model.md), [ADR-012](../../../docs/adr/012-acceptance-tier-mechanics.md)). Each file is the executable definition of done for one GitHub issue: `issue-NNN-<capability>.acceptance.test.ts`, with a `describe` title that starts `#N`. The Rust half is in [`src-tauri/tests/acceptance/`](../../../src-tauri/tests/acceptance/).

Tests here run against real things — a git repository and a JSONL audit file in a temp directory (`support/temp-project.ts`) — and read side effects back from disk. No mocks or recording doubles. Every test pairs the behavior it checks with a negative control, so a hook that blocks everything, or logs everything, cannot pass. The full rules are in [testing-requirements.md](../../../standards/process-standards/testing-requirements.md#acceptance-tests).

```bash
npm run test:acceptance                              # this directory
npx vitest run --project acceptance issue-007        # one issue
```

| Issue | File |
| --- | --- |
| #7 — identity and scope enforcement | `issue-007-identity-scope.acceptance.test.ts` |
| #10 — tool audit hooks | `issue-010-audit-hook.acceptance.test.ts` |
