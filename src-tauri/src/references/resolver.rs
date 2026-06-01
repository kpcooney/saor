// references/resolver.rs
//
// URI scheme resolution strategies. Each supported scheme has a dedicated
// resolver function:
//
//   resolve_file_uri      — reads a file from the project directory,
//                           returning its contents as a string
//   resolve_standards_uri — walks the two-tier standards override chain
//                           ({project_root}/.sdlc/standards/ → {standards_root}/)
//                           and returns the content of the first match
//   resolve_memory_uri    — dispatches to the memory store's keyword search
//
// The top-level `resolve_ref` reads the scheme prefix and routes to the
// appropriate resolver. tracker:// returns a Phase-3 deferral error.
// Unknown schemes return a descriptive error rather than panicking.
//
// Security:
//   - file:// and standards:// resolution rejects path traversal lexically
//     before any I/O — any `..` component or absolute path is refused. This
//     means a malicious URI like `file:///../../etc/passwd` cannot reach a
//     syscall, regardless of whether the target file exists.
//   - The agent-specific (third) tier of the standards model lives in the
//     agent definition layer, not here. The resolver only sees the URI
//     after agent-specific resolution has already produced a standards path.
//
// See docs/architecture/sdlc-agent-architecture-research-v4.md
//   Section 5.4 — resolve_ref tool definition and supported URI schemes
//   Section 4.2 — Three-tier standards model

use std::path::{Component, Path};

use rusqlite::Connection;
use thiserror::Error;

use crate::memory::{MemoryEntry, MemoryError};

const FILE_SCHEME: &str = "file://";
const STANDARDS_SCHEME: &str = "standards://";
const MEMORY_SCHEME: &str = "memory://";
const TRACKER_SCHEME: &str = "tracker://";

/// Default keyword-search result limit for memory:// URIs. Manifests do
/// not currently encode a limit; agents that need finer control go
/// through the memory MCP tool directly.
const DEFAULT_MEMORY_QUERY_LIMIT: i64 = 20;

/// File extension appended to standards:// URIs that omit it. The
/// standards tree stores Markdown files, and manifests reference them
/// by path without extension (`standards://coding-standards/typescript`).
const STANDARDS_FILE_EXTENSION: &str = "md";

/// Errors produced by URI resolution. Distinguishes the categories that
/// callers will want to react to differently:
///
///   - UnknownScheme / TrackerNotImplemented / MalformedUri — caller
///     error, the URI itself is the problem
///   - PathTraversal — security violation, the URI tried to escape the
///     project or standards root
///   - NotFound / Io — the URI was well-formed but the target is missing
///     or unreadable
///   - Memory — propagated from the memory store
#[derive(Debug, Error)]
pub enum ResolverError {
    /// The URI did not start with a recognised scheme prefix.
    #[error("unknown URI scheme: {uri}")]
    UnknownScheme { uri: String },

    /// `tracker://` URIs are reserved for the Phase 3 issue tracker MCP
    /// server; the resolver explicitly refuses them rather than falling
    /// through to UnknownScheme so the deferral is visible to callers.
    #[error("tracker:// URIs are not implemented in Phase 1 (uri: {uri})")]
    TrackerNotImplemented { uri: String },

    /// The URI body was empty or did not match the scheme's expected
    /// structure (e.g., memory:// without `query/`, standards:// with no
    /// path component).
    #[error("malformed URI {uri}: {reason}")]
    MalformedUri { uri: String, reason: String },

    /// The resolved path attempted to escape its configured root.
    /// Rejected before any I/O — see the security note in the module
    /// doc comment.
    #[error("path traversal rejected: {path}")]
    PathTraversal { path: String },

    /// The URI was well-formed but the target file does not exist. For
    /// standards:// this means the file was missing in both tiers.
    #[error("not found: {path}")]
    NotFound { path: String },

    /// I/O error reading a file that was successfully located. Distinct
    /// from NotFound so callers can distinguish "missing" from "broken".
    #[error("I/O error reading {path}: {source}")]
    Io {
        path: String,
        #[source]
        source: std::io::Error,
    },

    /// Downstream error from the memory store (FTS5 query failure, etc.).
    #[error("memory store error: {0}")]
    Memory(#[from] MemoryError),
}

/// The result of resolving a reference URI. file:// and standards://
/// produce string content; memory:// produces structured entries that
/// the MCP layer can serialise as JSON. Keeping the entry list typed
/// here means downstream consumers (issue #9 MCP tool) do not have to
/// re-parse rows.
#[derive(Debug)]
pub enum ResolvedReference {
    /// File or standards content as raw text.
    Content(String),

    /// Memory entries returned by keyword search, ordered by BM25 rank.
    MemoryEntries(Vec<MemoryEntry>),
}

/// Top-level dispatcher. Reads the scheme prefix of `uri` and routes to
/// the appropriate resolver. Returns:
///
///   - ResolvedReference::Content for file:// and standards://
///   - ResolvedReference::MemoryEntries for memory://
///   - Err(TrackerNotImplemented) for tracker://
///   - Err(UnknownScheme) for anything else
///
/// Path traversal is enforced inside the per-scheme resolvers, not here.
pub fn resolve_ref(
    uri: &str,
    project_root: &Path,
    standards_root: &Path,
    memory_conn: &Connection,
) -> Result<ResolvedReference, ResolverError> {
    if uri.starts_with(FILE_SCHEME) {
        return resolve_file_uri(uri, project_root).map(ResolvedReference::Content);
    }
    if uri.starts_with(STANDARDS_SCHEME) {
        return resolve_standards_uri(uri, project_root, standards_root)
            .map(ResolvedReference::Content);
    }
    if uri.starts_with(MEMORY_SCHEME) {
        return resolve_memory_uri(uri, memory_conn).map(ResolvedReference::MemoryEntries);
    }
    if uri.starts_with(TRACKER_SCHEME) {
        return Err(ResolverError::TrackerNotImplemented {
            uri: uri.to_string(),
        });
    }
    Err(ResolverError::UnknownScheme {
        uri: uri.to_string(),
    })
}

/// Resolves a `file://` URI to the contents of the file. The path
/// component is interpreted as a relative path within `project_root`.
/// Both `file:///docs/foo.md` and `file://docs/foo.md` are accepted —
/// a single leading `/` after the scheme is treated as a separator,
/// not as an absolute filesystem root.
///
/// Path traversal (any `..` component, or an absolute path on platforms
/// where one survives the leading-slash strip) is rejected lexically
/// before any filesystem call.
pub fn resolve_file_uri(uri: &str, project_root: &Path) -> Result<String, ResolverError> {
    let raw_path = uri
        .strip_prefix(FILE_SCHEME)
        .ok_or_else(|| ResolverError::UnknownScheme {
            uri: uri.to_string(),
        })?;

    let rel_path = raw_path.trim_start_matches('/');
    if rel_path.is_empty() {
        return Err(ResolverError::MalformedUri {
            uri: uri.to_string(),
            reason: "missing path component".to_string(),
        });
    }

    validate_relative_path(rel_path)?;
    read_file(&project_root.join(rel_path))
}

/// Resolves a `standards://` URI by walking the override chain:
///
///   1. `{project_root}/.sdlc/standards/{path}.md` (project override)
///   2. `{standards_root}/{path}.md` (system default)
///
/// The `.md` extension is appended automatically if the URI omits it
/// (manifests typically reference `standards://coding-standards/typescript`,
/// not `...typescript.md`). Returns NotFound if the file is missing in
/// both tiers. Path traversal is checked once against the joined path —
/// the same relative path is used for both tiers so a single check suffices.
pub fn resolve_standards_uri(
    uri: &str,
    project_root: &Path,
    standards_root: &Path,
) -> Result<String, ResolverError> {
    let raw_path =
        uri.strip_prefix(STANDARDS_SCHEME)
            .ok_or_else(|| ResolverError::UnknownScheme {
                uri: uri.to_string(),
            })?;

    let rel_path = raw_path.trim_start_matches('/');
    if rel_path.is_empty() {
        return Err(ResolverError::MalformedUri {
            uri: uri.to_string(),
            reason: "missing standards path".to_string(),
        });
    }

    let with_ext = ensure_extension(rel_path, STANDARDS_FILE_EXTENSION);
    validate_relative_path(&with_ext)?;

    let project_override = project_root.join(".sdlc").join("standards").join(&with_ext);
    if project_override.is_file() {
        return read_file(&project_override);
    }

    let system_default = standards_root.join(&with_ext);
    if system_default.is_file() {
        return read_file(&system_default);
    }

    Err(ResolverError::NotFound { path: with_ext })
}

/// Resolves a `memory://` URI by dispatching to the memory store's
/// FTS5 keyword search. Only the `query/<terms>` form is supported in
/// Phase 1 — `+` separates keywords, matching the manifest examples in
/// architecture Section 5.2. The terms are passed through to FTS5 as a
/// space-separated query (implicit AND), so callers can use FTS5
/// operators (OR, NOT, "phrase", prefix*) by URL-encoding them.
pub fn resolve_memory_uri(uri: &str, conn: &Connection) -> Result<Vec<MemoryEntry>, ResolverError> {
    let raw = uri
        .strip_prefix(MEMORY_SCHEME)
        .ok_or_else(|| ResolverError::UnknownScheme {
            uri: uri.to_string(),
        })?;

    let query_body = raw
        .strip_prefix("query/")
        .ok_or_else(|| ResolverError::MalformedUri {
            uri: uri.to_string(),
            reason: "expected memory://query/<terms>".to_string(),
        })?;

    if query_body.is_empty() {
        return Err(ResolverError::MalformedUri {
            uri: uri.to_string(),
            reason: "empty query".to_string(),
        });
    }

    let query = query_body.replace('+', " ");
    let results = crate::memory::fts::keyword_search(conn, &query, DEFAULT_MEMORY_QUERY_LIMIT)?;
    Ok(results)
}

// --- internal helpers -------------------------------------------------

/// Lexically rejects any relative path that contains a parent-directory
/// component (`..`) or that resolves to an absolute path. This is the
/// single chokepoint for path-traversal protection — both file:// and
/// standards:// run paths through here before any I/O.
///
/// The check is purely lexical (does not consult the filesystem). That
/// matters for two reasons:
///
///   1. It works for files that do not yet exist — the standards
///      override discovery may probe a path that is missing in the
///      project tier and present in the default tier, and we must reject
///      `../../foo` *before* we know whether the file exists.
///   2. A malicious URI cannot reach a syscall, so symlink-based
///      escape vectors are moot here. (The reads themselves still go
///      through `std::fs::read_to_string`, which follows symlinks; if
///      the configured root contains attacker-writable symlinks, that is
///      a deployment concern outside this resolver's threat model.)
fn validate_relative_path(rel_path: &str) -> Result<(), ResolverError> {
    let candidate = Path::new(rel_path);
    if candidate.is_absolute() {
        return Err(ResolverError::PathTraversal {
            path: rel_path.to_string(),
        });
    }
    for component in candidate.components() {
        match component {
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(ResolverError::PathTraversal {
                    path: rel_path.to_string(),
                });
            }
            _ => {}
        }
    }
    Ok(())
}

/// Returns `path` unchanged if it already ends with `.{ext}`; otherwise
/// appends the extension. Used to make standards:// URIs ergonomic —
/// callers don't have to remember the file extension.
fn ensure_extension(path: &str, ext: &str) -> String {
    let suffix = format!(".{ext}");
    if path.ends_with(&suffix) {
        path.to_string()
    } else {
        format!("{path}{suffix}")
    }
}

fn read_file(path: &Path) -> Result<String, ResolverError> {
    match std::fs::read_to_string(path) {
        Ok(content) => Ok(content),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Err(ResolverError::NotFound {
            path: path.display().to_string(),
        }),
        Err(err) => Err(ResolverError::Io {
            path: path.display().to_string(),
            source: err,
        }),
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;

    use rusqlite::Connection;
    use tempfile::TempDir;

    use super::*;
    use crate::memory::{MemoryCategory, MemoryEntry, SqliteMemoryStore};

    /// Sets up a temporary project root with a docs directory and a
    /// sample file. Returns the TempDir (kept alive for the test) and
    /// the project root path.
    fn make_project_with_file(rel_path: &str, content: &str) -> (TempDir, PathBuf) {
        let dir = TempDir::new().unwrap();
        let project_root = dir.path().to_path_buf();
        let full = project_root.join(rel_path);
        fs::create_dir_all(full.parent().unwrap()).unwrap();
        fs::write(&full, content).unwrap();
        (dir, project_root)
    }

    /// Sets up a standards tree with a single file at `rel_path` (with
    /// .md extension) containing `content`. Returns the TempDir and the
    /// standards root path.
    fn make_standards_root(rel_path: &str, content: &str) -> (TempDir, PathBuf) {
        let dir = TempDir::new().unwrap();
        let root = dir.path().to_path_buf();
        let full = root.join(rel_path);
        fs::create_dir_all(full.parent().unwrap()).unwrap();
        fs::write(&full, content).unwrap();
        (dir, root)
    }

    /// Writes a project override standards file under
    /// `{project_root}/.sdlc/standards/{rel_path}`.
    fn write_project_override(project_root: &Path, rel_path: &str, content: &str) {
        let full = project_root.join(".sdlc").join("standards").join(rel_path);
        fs::create_dir_all(full.parent().unwrap()).unwrap();
        fs::write(&full, content).unwrap();
    }

    fn empty_memory_conn() -> Connection {
        let store = SqliteMemoryStore::new_in_memory().unwrap();
        // The connection lives inside the store; tests that need to call
        // resolve_memory_uri build their own store via helper below.
        // This helper exists only for tests that just need *a* connection.
        drop(store);
        Connection::open_in_memory().unwrap()
    }

    // -- file:// -------------------------------------------------------

    #[test]
    fn test_resolve_file_uri_returns_content_for_valid_path() {
        let (_dir, project_root) =
            make_project_with_file("docs/adr/001-foo.md", "# ADR 001\n\nbody");

        let content = resolve_file_uri("file:///docs/adr/001-foo.md", &project_root).unwrap();
        assert_eq!(content, "# ADR 001\n\nbody");
    }

    #[test]
    fn test_resolve_file_uri_accepts_uri_without_leading_slash() {
        // Both file:///docs/foo and file://docs/foo are accepted — the
        // path is interpreted relative to project_root either way.
        let (_dir, project_root) = make_project_with_file("docs/foo.md", "hello");

        let content = resolve_file_uri("file://docs/foo.md", &project_root).unwrap();
        assert_eq!(content, "hello");
    }

    #[test]
    fn test_resolve_file_uri_rejects_path_traversal() {
        let (_dir, project_root) = make_project_with_file("docs/foo.md", "ok");

        let err = resolve_file_uri("file:///../../etc/passwd", &project_root).unwrap_err();
        assert!(
            matches!(err, ResolverError::PathTraversal { .. }),
            "expected PathTraversal, got {err:?}"
        );
    }

    #[test]
    fn test_resolve_file_uri_rejects_path_traversal_in_middle_of_path() {
        // A `..` component anywhere in the path is rejected, even if the
        // overall path *would* still resolve under project_root after
        // normalisation. Lexical rejection is stricter than semantic
        // rejection on purpose — see the validate_relative_path doc.
        let (_dir, project_root) = make_project_with_file("docs/foo.md", "ok");

        let err = resolve_file_uri("file:///docs/../docs/foo.md", &project_root).unwrap_err();
        assert!(matches!(err, ResolverError::PathTraversal { .. }));
    }

    #[test]
    fn test_resolve_file_uri_returns_not_found_for_missing_file() {
        let dir = TempDir::new().unwrap();
        let err = resolve_file_uri("file:///does/not/exist.md", dir.path()).unwrap_err();
        assert!(matches!(err, ResolverError::NotFound { .. }));
    }

    #[test]
    fn test_resolve_file_uri_rejects_empty_path() {
        let dir = TempDir::new().unwrap();
        let err = resolve_file_uri("file://", dir.path()).unwrap_err();
        assert!(matches!(err, ResolverError::MalformedUri { .. }));
    }

    #[test]
    fn test_resolve_file_uri_rejects_wrong_scheme() {
        let dir = TempDir::new().unwrap();
        let err = resolve_file_uri("standards://foo", dir.path()).unwrap_err();
        assert!(matches!(err, ResolverError::UnknownScheme { .. }));
    }

    // -- standards:// --------------------------------------------------

    #[test]
    fn test_resolve_standards_uri_returns_system_default_when_no_override() {
        let (_sd, standards_root) = make_standards_root(
            "coding-standards/typescript.md",
            "# TypeScript Standards (default)",
        );
        let project_dir = TempDir::new().unwrap();

        let content = resolve_standards_uri(
            "standards://coding-standards/typescript",
            project_dir.path(),
            &standards_root,
        )
        .unwrap();
        assert_eq!(content, "# TypeScript Standards (default)");
    }

    #[test]
    fn test_resolve_standards_uri_prefers_project_override_over_default() {
        let (_sd, standards_root) = make_standards_root(
            "coding-standards/typescript.md",
            "# TypeScript Standards (default)",
        );
        let project_dir = TempDir::new().unwrap();
        write_project_override(
            project_dir.path(),
            "coding-standards/typescript.md",
            "# TypeScript Standards (project override)",
        );

        let content = resolve_standards_uri(
            "standards://coding-standards/typescript",
            project_dir.path(),
            &standards_root,
        )
        .unwrap();
        assert_eq!(content, "# TypeScript Standards (project override)");
    }

    #[test]
    fn test_resolve_standards_uri_returns_not_found_when_missing_in_both_tiers() {
        let standards_dir = TempDir::new().unwrap();
        let project_dir = TempDir::new().unwrap();

        let err = resolve_standards_uri(
            "standards://coding-standards/cobol",
            project_dir.path(),
            standards_dir.path(),
        )
        .unwrap_err();
        assert!(
            matches!(err, ResolverError::NotFound { .. }),
            "expected NotFound, got {err:?}"
        );
    }

    #[test]
    fn test_resolve_standards_uri_accepts_explicit_extension() {
        // standards://path/to/file.md should also work — the auto-append
        // logic must not double-append the extension.
        let (_sd, standards_root) =
            make_standards_root("coding-standards/rust.md", "# Rust Standards");
        let project_dir = TempDir::new().unwrap();

        let content = resolve_standards_uri(
            "standards://coding-standards/rust.md",
            project_dir.path(),
            &standards_root,
        )
        .unwrap();
        assert_eq!(content, "# Rust Standards");
    }

    #[test]
    fn test_resolve_standards_uri_rejects_path_traversal() {
        let standards_dir = TempDir::new().unwrap();
        let project_dir = TempDir::new().unwrap();

        let err = resolve_standards_uri(
            "standards://../../etc/passwd",
            project_dir.path(),
            standards_dir.path(),
        )
        .unwrap_err();
        assert!(matches!(err, ResolverError::PathTraversal { .. }));
    }

    #[test]
    fn test_resolve_standards_uri_rejects_empty_path() {
        let standards_dir = TempDir::new().unwrap();
        let project_dir = TempDir::new().unwrap();

        let err = resolve_standards_uri("standards://", project_dir.path(), standards_dir.path())
            .unwrap_err();
        assert!(matches!(err, ResolverError::MalformedUri { .. }));
    }

    // -- memory:// -----------------------------------------------------

    /// Sets up an in-memory SqliteMemoryStore with a project row and a
    /// few entries, then returns the store. Tests call
    /// `store.connection()` to get a `&Connection` for resolve_memory_uri.
    fn make_populated_memory_store() -> SqliteMemoryStore {
        let store = SqliteMemoryStore::new_in_memory().unwrap();
        store
            .connection()
            .execute(
                "INSERT INTO projects (id, name, description, created_at, config)
                 VALUES ('test-project', 'Test', 'Test project', '2026-05-06T00:00:00Z', '{}')",
                [],
            )
            .unwrap();

        for (id, content, category) in &[
            (
                "e1",
                "auth implementation uses JWT tokens",
                MemoryCategory::Learning,
            ),
            (
                "e2",
                "we decided OAuth2 for third-party login",
                MemoryCategory::Convention,
            ),
            (
                "e3",
                "audit log truncation strategy lives elsewhere",
                MemoryCategory::Context,
            ),
        ] {
            store
                .write_entry(&MemoryEntry {
                    id: id.to_string(),
                    project_id: "test-project".to_string(),
                    category: category.clone(),
                    content: content.to_string(),
                    metadata: serde_json::json!(null),
                    created_by: "agent:test".to_string(),
                    created_at: "2026-05-06T00:00:00Z".to_string(),
                    weight: 1.0,
                })
                .unwrap();
        }
        store
    }

    #[test]
    fn test_resolve_memory_uri_returns_keyword_matches() {
        let store = make_populated_memory_store();
        let entries = resolve_memory_uri("memory://query/auth", store.connection()).unwrap();
        let ids: Vec<&str> = entries.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(ids, vec!["e1"]);
    }

    #[test]
    fn test_resolve_memory_uri_translates_plus_to_space_for_multi_term_query() {
        // `+` separator is the manifest convention (architecture 5.2).
        // Both terms must be required for the entry to match — implicit AND.
        let store = make_populated_memory_store();
        let entries = resolve_memory_uri("memory://query/auth+JWT", store.connection()).unwrap();
        let ids: Vec<&str> = entries.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(ids, vec!["e1"], "only e1 contains both 'auth' and 'JWT'");
    }

    #[test]
    fn test_resolve_memory_uri_rejects_uri_without_query_prefix() {
        let store = make_populated_memory_store();
        let err = resolve_memory_uri("memory://something-else", store.connection()).unwrap_err();
        assert!(
            matches!(err, ResolverError::MalformedUri { .. }),
            "expected MalformedUri, got {err:?}"
        );
    }

    #[test]
    fn test_resolve_memory_uri_rejects_empty_query() {
        let store = make_populated_memory_store();
        let err = resolve_memory_uri("memory://query/", store.connection()).unwrap_err();
        assert!(matches!(err, ResolverError::MalformedUri { .. }));
    }

    // -- dispatcher (resolve_ref) --------------------------------------

    #[test]
    fn test_resolve_ref_dispatches_file_scheme_to_content() {
        let (_dir, project_root) = make_project_with_file("docs/foo.md", "file body");
        let standards_dir = TempDir::new().unwrap();
        let conn = empty_memory_conn();

        let result = resolve_ref(
            "file:///docs/foo.md",
            &project_root,
            standards_dir.path(),
            &conn,
        )
        .unwrap();
        match result {
            ResolvedReference::Content(s) => assert_eq!(s, "file body"),
            other => panic!("expected Content, got {other:?}"),
        }
    }

    #[test]
    fn test_resolve_ref_dispatches_standards_scheme_to_content() {
        let (_sd, standards_root) = make_standards_root("coding-standards/python.md", "# Python");
        let project_dir = TempDir::new().unwrap();
        let conn = empty_memory_conn();

        let result = resolve_ref(
            "standards://coding-standards/python",
            project_dir.path(),
            &standards_root,
            &conn,
        )
        .unwrap();
        match result {
            ResolvedReference::Content(s) => assert_eq!(s, "# Python"),
            other => panic!("expected Content, got {other:?}"),
        }
    }

    #[test]
    fn test_resolve_ref_dispatches_memory_scheme_to_entries() {
        let store = make_populated_memory_store();
        let project_dir = TempDir::new().unwrap();
        let standards_dir = TempDir::new().unwrap();

        let result = resolve_ref(
            "memory://query/audit",
            project_dir.path(),
            standards_dir.path(),
            store.connection(),
        )
        .unwrap();
        match result {
            ResolvedReference::MemoryEntries(entries) => {
                let ids: Vec<&str> = entries.iter().map(|e| e.id.as_str()).collect();
                assert_eq!(ids, vec!["e3"]);
            }
            other => panic!("expected MemoryEntries, got {other:?}"),
        }
    }

    #[test]
    fn test_resolve_ref_returns_tracker_not_implemented_for_tracker_scheme() {
        let project_dir = TempDir::new().unwrap();
        let standards_dir = TempDir::new().unwrap();
        let conn = empty_memory_conn();

        let err = resolve_ref(
            "tracker://PROJ-167",
            project_dir.path(),
            standards_dir.path(),
            &conn,
        )
        .unwrap_err();
        assert!(
            matches!(err, ResolverError::TrackerNotImplemented { .. }),
            "expected TrackerNotImplemented, got {err:?}"
        );
    }

    #[test]
    fn test_resolve_ref_returns_unknown_scheme_for_unrecognized_uri() {
        let project_dir = TempDir::new().unwrap();
        let standards_dir = TempDir::new().unwrap();
        let conn = empty_memory_conn();

        let err = resolve_ref(
            "audit://project/PROJ-167",
            project_dir.path(),
            standards_dir.path(),
            &conn,
        )
        .unwrap_err();
        assert!(
            matches!(err, ResolverError::UnknownScheme { .. }),
            "expected UnknownScheme, got {err:?}"
        );
    }

    #[test]
    fn test_resolve_ref_returns_unknown_scheme_for_garbage_input() {
        let project_dir = TempDir::new().unwrap();
        let standards_dir = TempDir::new().unwrap();
        let conn = empty_memory_conn();

        let err = resolve_ref(
            "not-a-uri-at-all",
            project_dir.path(),
            standards_dir.path(),
            &conn,
        )
        .unwrap_err();
        assert!(matches!(err, ResolverError::UnknownScheme { .. }));
    }

    // -- helper sanity -------------------------------------------------

    #[test]
    fn test_ensure_extension_does_not_double_append() {
        assert_eq!(ensure_extension("foo", "md"), "foo.md");
        assert_eq!(ensure_extension("foo.md", "md"), "foo.md");
        // A different extension is treated as a different filename.
        assert_eq!(ensure_extension("foo.txt", "md"), "foo.txt.md");
    }
}
