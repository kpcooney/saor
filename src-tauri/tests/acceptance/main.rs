// src-tauri/tests/acceptance/main.rs
//
// The Rust half of the acceptance tier (ADR-007, ADR-012): one module per
// GitHub issue, each the executable definition of done for that issue's
// capability. Run on its own with:
//
//   cargo test --test acceptance                    (the whole Rust tier)
//   cargo test --test acceptance issue_004          (one issue)
//
// Rules for everything in this directory:
//
//   - Real stores only — SQLite files and JSONL files in a temp directory,
//     driven through the crate's public API as an outside caller would. No
//     mocks, no reaching into private state.
//   - Side effects are verified by reading them back, where possible through a
//     different handle than the one that wrote them (a reopened store, the raw
//     file on disk).
//   - Every test carries a negative control: an assertion that would fail if
//     the capability were replaced by something degenerate (a store that
//     returns everything, a resolver that never refuses).
//   - A module is named `issue_NNN_<capability>`, so a failing test names the
//     issue whose definition of done it broke.
//
// Unit tests stay next to the code they test (`#[cfg(test)]` modules); see
// standards/process-standards/testing-requirements.md for which tier a test
// belongs in.

mod issue_004_memory_store;
mod issue_005_audit_store;
mod issue_006_reference_resolver;
