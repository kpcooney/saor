# Commit Conventions

This project uses [Conventional Commits](https://www.conventionalcommits.org/). Every commit message must follow this format. Commits that do not follow the format will be flagged in review.

## Format

```
type(scope): description

[optional body]

[optional footer]
```

- **type**: what kind of change this is (see below)
- **scope**: what part of the codebase is affected (see below)
- **description**: imperative mood, lowercase, no trailing period, ≤72 characters
- **body**: optional; use to explain *why*, not *what* — the diff shows what changed
- **footer**: optional; use for `BREAKING CHANGE:` notes or issue references (`Closes #NNN`)

## Allowed Types

| Type | When to use |
|------|-------------|
| `feat` | A new feature or capability |
| `fix` | A bug fix |
| `docs` | Documentation changes only (README, standards, ADRs, comments) |
| `refactor` | Code restructuring that neither adds a feature nor fixes a bug |
| `test` | Adding or correcting tests |
| `chore` | Tooling, dependency updates, configuration, scaffolding |
| `build` | Changes to the build system or CI (Cargo.toml, package.json, GitHub Actions) |

## Allowed Scopes

| Scope | What it covers |
|-------|---------------|
| `tauri` | Rust backend (`src-tauri/`) |
| `frontend` | Svelte frontend (`src/`) |
| `agents` | TypeScript agent layer (`agents/`) |
| `memory` | Memory store module |
| `audit` | Audit store module |
| `mcp` | MCP server definitions |
| `standards` | Standards files (`standards/`) |

Use the most specific applicable scope. If a commit genuinely touches multiple scopes at the same level, use the higher-level scope (`tauri` instead of `memory` if you touched both memory and audit).

## Breaking Changes

For changes that break the existing API or behavior:

```
feat(memory)!: change keyword_search return type to include rank score

BREAKING CHANGE: keyword_search now returns Vec<RankedEntry> instead of
Vec<MemoryEntry>. Update all call sites to destructure the rank field.
```

The `!` after the scope signals a breaking change. The `BREAKING CHANGE:` footer provides migration notes.

## Examples

```
feat(memory): implement FTS5 keyword search with BM25 ranking
```
```
fix(tauri): handle missing project directory in memory store initialize
```
```
docs(standards): add rust coding conventions
```
```
refactor(agents): extract scope validation into separate function
```
```
test(audit): add tests for JSONL append and read-back ordering
```
```
chore(agents): initialize agents package with package.json and tsconfig
```
```
build(tauri): add thiserror and anyhow dependencies to Cargo.toml
```
```
feat(agents): add code agent identity definition

Implements the AgentIdentity schema for the Code Agent, including scope
restrictions (src/** file glob, Write/Edit/Bash/Read tools only) and
references to the applicable coding and testing standards.

Closes #18
```

## Rules

- Write the description in imperative mood: "add", "fix", "implement", not "added", "fixes", "implementing".
- Keep the first line (type + scope + description) under 72 characters so it reads cleanly in `git log --oneline`.
- Do not end the description with a period.
- One logical change per commit. If you did three things, make three commits.
- Reference the issue in the footer (`Closes #NNN`) rather than in the description.
