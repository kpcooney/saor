# Rust Coding Standards

Applies to the Tauri backend in `src-tauri/`. The Rust layer is intentionally thin — it handles storage, process management, and IPC. Business logic lives in the TypeScript agent layer.

## Module Organization

- One concept per module. `memory/store.rs` contains the store implementation; `memory/schema.rs` contains SQL definitions; `memory/fts.rs` contains FTS5 search logic. Do not mix concerns in a single file.
- Keep `mod.rs` files short — they declare submodules and re-export the public API of the module. Implementation goes in the subfiles.
- Modules declare their public API explicitly. Prefer `pub(crate)` over `pub` for items that should not cross the crate boundary.

## Error Handling

- Use `thiserror` for library-style errors (types in the `memory`, `audit`, `identity`, `references` modules). Define a typed `Error` enum per module; do not use `Box<dyn Error>` in public APIs.
- Use `anyhow` in application-level code (IPC command handlers in `lib.rs`, `main.rs`, and the `process` module) where you need to propagate heterogeneous errors with context.
- Never use `.unwrap()` in non-test code. Use `?` to propagate, or handle the error explicitly with a meaningful message. The one exception: values that are truly impossible to be `None`/`Err` due to invariants established before the call — document this invariant with a comment.
- Never use `.expect()` in production paths without a message that explains the invariant being asserted.

```rust
// Correct: typed error with thiserror
#[derive(Debug, thiserror::Error)]
pub enum MemoryError {
    #[error("database error: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("entry not found: {id}")]
    NotFound { id: String },
}

// Correct: anyhow in command handlers for context chaining
#[tauri::command]
async fn search_memory(query: String) -> Result<Vec<MemoryEntry>, String> {
    let results = memory_store
        .search(&query)
        .map_err(|e| format!("memory search failed: {e}"))?;
    Ok(results)
}
```

## Clippy

- Run `cargo clippy -- -W clippy::pedantic` in CI. All warnings must be resolved, not suppressed.
- If suppressing a specific lint is necessary, use `#[allow(clippy::lint_name)]` on the smallest scope possible (the function, not the module), with a comment explaining why.
- `cargo fmt` must be run before every commit. Code that doesn't format cleanly is not mergeable.

## Unsafe Code

- No `unsafe` blocks without an accompanying comment explaining:
  1. What invariant makes this safe
  2. What would go wrong if that invariant were violated
  3. Why a safe alternative is not available

If you cannot write that comment clearly, find a safe alternative.

## Traits and Generics

- Prefer `impl Trait` in function signatures over `dyn Trait` when the concrete type is known at compile time. Use `dyn Trait` only for true runtime polymorphism (e.g., the abstracted store backends).
- Keep trait bounds in `where` clauses for functions with multiple bounds — it is more readable than inline bounds.

```rust
// Correct: where clause for readability
pub fn initialize_store<S>(store: S, config: StoreConfig) -> Result<(), MemoryError>
where
    S: MemoryStore + Send + Sync,
{
    store.initialize(config)
}
```

## Concurrency

- Use `tokio` for async runtime (Tauri provides it). Prefer `async fn` over blocking calls in command handlers.
- Do not block the async runtime — use `tokio::task::spawn_blocking` for CPU-bound or blocking I/O work.
- Keep shared state in `Arc<Mutex<T>>` or `Arc<RwLock<T>>` and document what invariants the lock protects.

## Testing

- Unit tests live in the same file as the code they test, in a `#[cfg(test)] mod tests { ... }` block.
- Integration tests (testing multiple modules together) live in `src-tauri/tests/`.
- Test names describe the behavior: `test_fts5_search_returns_results_ranked_by_relevance`, not `test_search`.
- Use real SQLite in-memory databases for storage tests — not mocks. `rusqlite` supports `Connection::open_in_memory()`.
- Every `pub` function that contains non-trivial logic must have at least one test.

## Documentation

- Every `pub` and `pub(crate)` item must have a doc comment (`///`). Describe the contract, not the implementation.
- Every file must have a module-level doc comment (`//!`) explaining what the module does and where it fits.
- Link to the architecture document and ADRs when implementing decisions described there.
- Non-obvious decisions (why `thiserror` here vs. `anyhow` there, why a particular schema choice) get inline comments explaining the reasoning.
