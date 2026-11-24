# src-tauri/tests/acceptance/

The Rust half of the **acceptance tier** ([ADR-007](../../../docs/adr/007-review-truth-model.md), [ADR-012](../../../docs/adr/012-acceptance-tier-mechanics.md)). Each `issue_NNN_<capability>.rs` file is the executable definition of done for one GitHub issue, and is a module of the single cargo test target rooted at `main.rs`. The files here are the list of issues this half covers. The TypeScript half is in [`agents/tests/acceptance/`](../../../agents/tests/acceptance/).

Tests here drive the crate's public API against real stores — SQLite and JSONL files in a temp directory — and read side effects back through a reopened store or the raw file. No mocks. Every test carries a negative control, so a store that returns everything, or a resolver that never refuses, cannot pass. The full rules are in [testing-requirements.md](../../../standards/process-standards/testing-requirements.md#acceptance-tests).

**Adding a file:** name it `issue_NNN_<capability>.rs` and add `mod issue_NNN_<capability>;` to `main.rs`. Cargo ignores a file that is not declared, so `every_acceptance_file_is_declared_as_a_module` (in `main.rs`) fails the tier until it is.

```bash
cargo test --test acceptance                 # this directory
cargo test --test acceptance issue_004       # one issue
```
