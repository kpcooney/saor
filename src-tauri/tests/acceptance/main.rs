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
//   - Every `issue_*.rs` file must be declared below. Cargo silently ignores a
//     file that is not, so `every_acceptance_file_is_declared_as_a_module`
//     fails the tier when one is missing.
//
// Unit tests stay next to the code they test (`#[cfg(test)]` modules); see
// standards/process-standards/testing-requirements.md for which tier a test
// belongs in.

mod issue_004_memory_store;
mod issue_005_audit_store;
mod issue_006_reference_resolver;
mod issue_078_session_transcript;

/// A file in this directory that `main.rs` does not declare is never compiled,
/// so its tests would be skipped without any warning while the tier stayed
/// green. This turns that into a failure, and holds the naming convention that
/// ties each file to its issue.
#[test]
fn every_acceptance_file_is_declared_as_a_module() {
    let directory = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("acceptance");
    let declarations = include_str!("main.rs");

    let mut issue_files = 0;
    for entry in std::fs::read_dir(&directory).unwrap() {
        let path = entry.unwrap().path();
        let name = path.file_name().unwrap().to_str().unwrap().to_string();
        if name == "main.rs" || name == "README.md" {
            continue;
        }

        let stem = name.strip_suffix(".rs").unwrap_or_else(|| {
            panic!("{name}: only Rust issue files, main.rs and README.md belong here")
        });
        let issue_number = stem
            .strip_prefix("issue_")
            .and_then(|rest| rest.split_once('_'))
            .map(|(number, _capability)| number)
            .unwrap_or_else(|| panic!("{name}: expected issue_NNN_<capability>.rs"));
        assert!(
            issue_number.len() == 3 && issue_number.chars().all(|c| c.is_ascii_digit()),
            "{name}: the issue number must be three digits, zero-padded"
        );
        assert!(
            declarations
                .lines()
                .any(|line| line == format!("mod {stem};")),
            "{name} is not declared in tests/acceptance/main.rs, so its tests never run. \
             Add `mod {stem};`."
        );
        issue_files += 1;
    }

    // Negative control: the loop really did look at the files that exist.
    assert!(issue_files >= 3, "found only {issue_files} issue files");
}
