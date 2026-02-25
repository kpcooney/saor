# Security Checklist

Security review checklist for Saor's architecture. Focus on the actual attack surfaces: a local desktop app that spawns agent subprocesses, manages file system access, and maintains a local SQLite database. Apply this checklist during code review for any PR that touches the areas listed below.

## SQL Injection (Memory and Audit Stores)

All SQL queries that incorporate user-controlled or agent-controlled data must use parameterized queries. Never concatenate strings into SQL.

- [ ] All `rusqlite` queries use `?` placeholder parameters, not `format!()` string building
- [ ] FTS5 MATCH queries parameterize the search term — FTS5 special characters in input are handled (either escaped or rejected)
- [ ] No dynamic table or column names constructed from input (these cannot be parameterized; validate strictly against an allowlist if dynamic names are unavoidable)

```rust
// Correct
conn.execute("INSERT INTO memory_entries (id, content) VALUES (?1, ?2)", params![id, content])?;

// Never do this
conn.execute(&format!("INSERT INTO memory_entries (id, content) VALUES ('{}', '{}')", id, content), [])?;
```

## Command Injection (Subprocess Spawning)

The agent process manager spawns Node.js subprocesses. Inputs to subprocess arguments must be validated.

- [ ] Arguments passed to spawned processes are passed as discrete array elements, never as a single shell string that gets parsed
- [ ] Project paths and agent identity fields passed to subprocess arguments are validated (no shell metacharacters: `;`, `|`, `&&`, `$()`, backticks, etc.)
- [ ] Environment variables set for subprocesses contain no user-controlled data without sanitization

## Broken Access Control (Agent Scope Enforcement)

Agent scope is a first-class security boundary. Review scope enforcement carefully.

- [ ] PreToolUse hook runs for **all** tools — no tool can bypass scope checking
- [ ] File glob matching is strict: `src/**` matches `src/foo.ts` but not `../src/foo.ts` — path traversal is rejected
- [ ] Normalized, absolute paths are compared — do not compare raw strings that could differ due to `./`, `../`, or symlinks
- [ ] Tool allowlist check uses exact string matching — no substring or prefix matching that could be tricked
- [ ] Expired credentials are rejected — check `expiresAt` before allowing any action

## File System Access Boundaries

The Rust backend reads and writes files. Validate that operations stay within expected boundaries.

- [ ] `file://` URI resolution normalizes the path and verifies it is within the project directory before reading
- [ ] `standards://` URI resolution stays within the `standards/` directory and `.sdlc/standards/` — path traversal (e.g., `standards://../../etc/passwd`) is rejected
- [ ] Audit log writes go to the `.sdlc/audit/` directory — not arbitrary paths

## Tauri Capabilities (Security Misconfiguration)

Tauri's capability model controls what the WebView can do. Keep the surface minimal.

- [ ] `src-tauri/capabilities/default.json` grants only the permissions the frontend actually uses
- [ ] The frontend does not have direct file system access — all file operations go through Tauri commands in the Rust backend
- [ ] `shell:execute` capability is not granted to the frontend — subprocess spawning is Rust-only

## Vulnerable Dependencies

- [ ] `cargo audit` passes with no high or critical vulnerabilities — run before opening a PR that adds or updates Cargo dependencies
- [ ] `npm audit` passes with no high or critical vulnerabilities — run before opening a PR that adds or updates npm dependencies
- [ ] New dependencies are justified in the PR description — do not add dependencies not implied by the architecture without discussion

## Secrets and Sensitive Data

- [ ] No API keys, tokens, or credentials are committed to the repository
- [ ] `.env` files and `.sdlc/` directories are gitignored
- [ ] Audit log entries do not include secret values from agent environment variables
- [ ] Log output (stdout/stderr of agent processes) is not forwarded to the audit store without filtering

## Notes on Threat Model

Saor is a local desktop application. The primary threats are:

1. **Agent scope escape** — an agent reads or writes files outside its declared scope. Mitigated by PreToolUse hooks and path validation.
2. **SQL injection** — a crafted query corrupts or leaks the memory database. Mitigated by parameterized queries throughout.
3. **Subprocess injection** — a malicious project configuration spawns unintended processes. Mitigated by input validation in the process manager.

Network-facing threats (authentication bypass, SSRF, CSRF) are not in scope for Phase 1 — the application has no network server. Revisit when issue tracker and cloud integrations are added in Phase 3.
