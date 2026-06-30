# CLAUDE.md — Saor Project Instructions

This file is the always-loaded **map** for working on Saor. It holds the foundational context and
the project's hard rules, and it anchors out to the documents that own each detail. When a section
here points to a standard or ADR, that linked document is authoritative — read it before acting in
that area.

## What Is Saor

Saor is an AI-powered SDLC orchestration platform. It coordinates specialist agents through the full software development lifecycle — requirements, UX, architecture, implementation, testing, deployment — using scoped agent identities, a shared memory layer, a reference-based handoff protocol, and a full audit trail.

The stack is Tauri 2.0 (Rust backend, Svelte/TypeScript frontend) with the Claude Agent SDK (TypeScript) powering the agent layer.

## Source of Truth

The architecture document is the authoritative reference for all technical decisions:

```
docs/architecture/sdlc-agent-architecture-research-v4.md
```

Read it before making structural decisions. Pay particular attention to Section 5 (Reference-Based Handoff Protocol) — it is the novel core of the architecture.

## Core Design Principles

These are non-negotiable. Do not deviate without explicit discussion and an ADR.

1. **Reference over copies**: Agents get URI manifests pointing to living documents, not summaries. Context is pulled on demand by the receiving agent, not pushed by the sender. Never implement summary-based handoffs.
2. **Standards are identity**: Every agent has standards baked into its definition, resolved through a three-tier chain (system defaults → project overrides → agent-specific). Standards are not optional or advisory.
3. **Issue IDs everywhere**: Every artifact carries traceability references (Initiative, Epic, Issue, related ADRs, PRs). The Documentation Specialist enforces this.
4. **Audit everything automatically**: The audit trail is a side effect of hooks, not opt-in. PostToolUse logs actions. PreToolUse logs scope violations. Agents do not choose whether to be audited.
5. **Abstract the backends**: Memory, audit, and issue tracking use interface abstractions. Start with the simplest implementation (SQLite, JSONL), swap later without changing the agent layer.
6. **Local-first**: Single SQLite file per project for memory. JSONL for audit (Phase 1). No cloud dependencies at runtime.
7. **Agent identity with delegation chains**: Every agent has scoped credentials and an immutable chain back to the human. The credential field is structured for future FIDO-like cryptographic extension.

## Project Structure

```
src-tauri/          Rust backend (Tauri core) — storage, process management, IPC
src/                Svelte + TypeScript frontend
agents/             TypeScript agent layer — definitions, coordinators, MCP servers
standards/          System default standards files (three-tier base layer)
docs/               Architecture docs, ADRs, project documentation
```

**About `src-tauri/`**: Tauri's standard convention — where the Rust code that plugs into the Tauri framework lives (app entry point, config, and our modules for storage, process management, and IPC). "IPC" is inter-process communication: the Svelte frontend calls Tauri's `invoke("some_command")`, which crosses into Rust and returns a result. It's the bridge between the UI and the backend. See [src-tauri/README.md](src-tauri/README.md).

**About `agents/`**: A separate TypeScript package from `src/`. It runs in its own process space via Tauri's sidecar mechanism, not in the browser — the Claude Agent SDK spawns CLI subprocesses, so the agent layer is a standalone Node.js package. See [agents/README.md](agents/README.md).

**README convention**: Every top-level directory and significant subdirectory has a `README.md` explaining what lives there, how it fits the system, and any local conventions. Keep them concise — a paragraph or two of orientation, not a full design document.

## How We Work

**Permissions.** Local development flows without prompt-by-prompt approval; the PR review gate is the quality boundary. What's allowed without asking vs. what needs explicit approval is defined in [standards/process-standards/local-permissions.md](standards/process-standards/local-permissions.md). The runtime allowlist is [`.claude/settings.local.json`](.claude/settings.local.json). Two rules worth stating up front: **never push directly to `main`** (Kevin merges via PR), and **do not modify this `CLAUDE.md` without explicit approval**.

**Development workflow.** Work happens on feature branches reviewed via GitHub PRs — this is the primary autonomy model, not prompt-by-prompt approval. Branch naming is `{issue-number}/{short-description}` off `main`; every branch ties to a GitHub issue. Commit early and often with [Conventional Commits](https://www.conventionalcommits.org/) (`type(scope): description`; scopes: `tauri`, `frontend`, `agents`, `memory`, `audit`, `standards`, `mcp`). The full cycle, what you can do autonomously, and how to respond to review comments (Justify / Adjust / Clarify — and **never resolve Kevin's comments yourself**) are in [standards/process-standards/git-workflow.md](standards/process-standards/git-workflow.md).

**Review assistance.** `/review-branch [branch|PR]` spawns three blind reviewer subagents plus a coordinator; `--review-fixes` re-reviews after fixes. The agents are advisory — Kevin remains the merge gate. See [ADR-004](docs/adr/004-review-assistance-protocol.md), [ADR-005](docs/adr/005-targeted-re-review-pattern.md), the command at [.claude/commands/review-branch.md](.claude/commands/review-branch.md), and the prompts in [standards/review-assistance/](standards/review-assistance/).

**Architectural decisions.** If you hit a design question the architecture doc doesn't cover, don't just pick an answer — if the decision would be hard to reverse, or a future reader would wonder "why did they do it this way?", write an ADR; otherwise ask. ADRs use the MADR template ([adr-format.md](standards/documentation-standards/adr-format.md)) and go through the normal PR workflow. When a PR implements or finalizes an ADR, flip that ADR's status to `accepted` in the same PR.

## Code Standards

Favor readable code over clever code, and document where it adds value. The cross-cutting rules live in [code-clarity.md](standards/coding-standards/code-clarity.md) and [code-documentation-format.md](standards/documentation-standards/code-documentation-format.md). Language specifics:

- **Rust**: standard `rustfmt` / `clippy`. Minimal surface — storage, process management, IPC only. See [rust.md](standards/coding-standards/rust.md).
- **TypeScript**: strict mode, ESLint + Prettier, interfaces over type aliases for public contracts. See [typescript.md](standards/coding-standards/typescript.md).
- **Svelte**: Svelte 5 runes (`$state`, `$derived`, `$effect`); prefer stores for shared state; keep components small (~150 lines max).

## Testing & Review-Truth

Tests are required for all non-trivial functionality and are reviewed alongside the implementation. What to test directly (real stores, no mocks), what to test with mocks, what not to unit-test, plus naming and location conventions are in [testing-requirements.md](standards/process-standards/testing-requirements.md).

The *intended* authority for "done" is machine-checked behavior plus mutation score — see [ADR-007](docs/adr/007-review-truth-model.md). **Today's actual gate is the unit suite plus human review (optionally `/review-branch`)** — the tagged acceptance tier and mutation testing ADR-007 describes are adopted as policy but **not yet built**, tracked by #50 and #51. Treat acceptance/mutation as the target, not the current process, until those land.

## Phase 1 Scope (Foundation)

**Done and merged**: SQLite memory store with FTS5 (#4), JSONL audit store (#5), reference resolver (#6), agent identity schema + PreToolUse scope enforcement (#7), PostToolUse audit hook (#10), Tauri scaffolding, system default standards.

**Remaining in Phase 1**: memory MCP server (#8) and reference-resolver MCP tool (#9) — both currently stubs; single Code Agent integration (#11); Tauri IPC commands (#12); basic UI — project creation, agent status, memory inspector (#13).

**Not in scope (later phases)**: coordinator agents and multi-agent orchestration (Phase 2); reference manifest handoff protocol between agents (Phase 2); issue tracker MCP server (Phase 3); workflow engine, parallel execution, approval workflows (Phase 3); semantic search / vector embeddings (Phase 4); FIDO-like cryptographic identity (Phase 5); cloud backends for memory or audit.

## Session Continuity

Session-to-session continuity comes from the memory layer, git history, and the issue tracker — not from handoff documents. After completing an issue (or when context runs low), post a brief status report to Kevin: what was completed, artifacts (files/PRs), what's next, and context usage (low/medium/high, continue or hand off).

## What Not To Do

- Do not implement summary-based handoffs. The reference manifest pattern is the architecture.
- Do not add vector search, embeddings, or semantic similarity in Phase 1.
- Do not build coordinator agents or multi-agent workflows in Phase 1.
- Do not add cloud dependencies or remote storage.
- Do not skip writing ADRs for decisions that aren't covered by the architecture doc.
- Do not put business logic in the Rust layer — it handles storage and process management. Agent logic lives in TypeScript.
- Do not push to `main`, force-push, or modify `CLAUDE.md` without explicit approval (see [local-permissions.md](standards/process-standards/local-permissions.md)).
