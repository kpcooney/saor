# CLAUDE.md — Saor Project Instructions

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

**About `src-tauri/`**: This is Tauri's standard convention — it's where all the Rust code lives that plugs into the Tauri framework. Created by `cargo tauri init`. It contains the app entry point, Tauri configuration, and all the Rust modules we write for storage (memory store, audit store), process management (spawning and monitoring agent subprocesses), and IPC command handlers. "IPC" stands for inter-process communication — it's how the Svelte frontend talks to the Rust backend. The frontend calls Tauri's `invoke("some_command")` function, which crosses the process boundary into Rust and returns a result. Think of it as the bridge between the UI and the backend.

**About `agents/`**: This is a separate TypeScript package from `src/`. It doesn't run in the browser — it runs in its own process space via Tauri's sidecar mechanism. The Claude Agent SDK spawns CLI subprocesses, so the agent layer needs to be a standalone Node.js package, not bundled into the Svelte frontend.

**README convention**: Every top-level directory and significant subdirectory should have a `README.md` explaining what lives there, how it fits into the system, and any conventions specific to that directory. These READMEs are the first thing a new reader (human or agent) encounters when navigating the project. Keep them concise — a paragraph or two of orientation, not a full design document.

## Conventions

### Commits
Use [Conventional Commits](https://www.conventionalcommits.org/) format: `type(scope): description`

Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `build`
Scopes: `tauri`, `frontend`, `agents`, `memory`, `audit`, `standards`, `mcp`

Examples:
- `feat(memory): implement SQLite memory store with FTS5`
- `docs(architecture): add ADR-001 audit store scoping`
- `chore(build): configure Tauri sidecar for agent SDK`

### Development Workflow

Work happens on feature branches, reviewed via GitHub pull requests. This is the primary autonomy model — you do not need prompt-by-prompt approval for implementation work. Instead, work independently on a branch and open a PR for review.

**Branch naming**: `{issue-number}/{short-description}` off `main`. The issue number ties the branch directly to its GitHub issue for traceability.
Examples: `12/sqlite-memory-store`, `15/jsonl-audit-writer`, `18/code-agent-identity`

**The workflow:**

1. **Pick up a task** from the current phase scope. If the task doesn't have a GitHub issue yet, create one first.
2. **Create a feature branch** from `main` using the naming convention above.
3. **Implement on the branch.** Commit early and often using Conventional Commits. Each commit should be a coherent unit — not a single massive commit at the end.
4. **Write tests** alongside the implementation (see Testing section below).
5. **Open a pull request on GitHub** when the work is ready for review. The PR description must follow the PR format standard (`standards/documentation-standards/pr-format.md`): summary, changes made, testing performed, traceability references (Issue, Epic if applicable, related ADRs), and any open questions.
6. **Wait for review.** The reviewer (Kevin) will leave comments on GitHub.
7. **Address review comments** by pushing additional commits to the same branch. Do not force-push or squash during review — the commit history should show what changed in response to feedback.
8. **Kevin merges.** Do not merge your own PRs. Kevin will approve and merge when satisfied.

**What you can do without asking:**
- Create feature branches and push commits
- Create GitHub issues for tasks within the current phase scope
- Open pull requests
- Respond to review comments with code changes
- Create ADRs for design decisions (these still go through PR review)

**What requires discussion first:**
- Anything that changes the architecture document or core design principles
- Scope changes (adding or removing Phase 1 deliverables)
- Introducing new dependencies not implied by the architecture

### Architectural Decisions
If you encounter a design question not covered by the architecture document, **do not just pick an answer and keep going**. If in doubt about the right direction, prompt for feedback — it's better to ask than to build on the wrong assumption. If the decision is significant enough to affect future work, write an ADR in `docs/adr/` using the MADR template from `standards/documentation-standards/adr-format.md`. ADRs go through the same PR workflow — branch, write, open PR for review.

The threshold for "write an ADR" vs. "just ask": if the decision would be hard to reverse later, or if a future reader would wonder "why did they do it this way?", it warrants an ADR.

### Code Style
- **Rust**: Follow standard `rustfmt` and `clippy` conventions. Minimal surface — Rust handles storage, process management, and IPC (inter-process communication with the frontend) only.
- **TypeScript**: Strict mode. ESLint + Prettier. Prefer interfaces over type aliases for public contracts.
- **Svelte**: Use Svelte 5 runes syntax (`$state`, `$derived`, `$effect`). Prefer Svelte stores for shared state. Components should be small and focused — if a component file exceeds ~150 lines, consider splitting it.

### Code Clarity

Favor readable code over clever or terse code. Someone unfamiliar with the project should be able to read a module and understand what it does without having to reverse-engineer intent from compressed logic.

- **Name things for what they mean**, not for brevity. `resolveStandardWithOverrideChain` is better than `resolve`. A variable called `agentDelegationChain` is better than `chain`.
- **Avoid unnecessary abstraction.** Don't introduce a factory or strategy pattern where a plain function works. The architecture already has enough abstraction layers — the code within each layer should be straightforward.
- **Break up complex logic.** If a function is doing five things, split it into named steps. Each step's name should explain the intent.
- **Use early returns** to reduce nesting. Guard clauses at the top of a function, happy path at the bottom.

### Code Documentation

Documentation should help someone not familiar with the codebase understand what they're looking at. It does not need to be on every function or every line — use judgment about where it adds value.

**Always document:**
- Module-level: every file should have a brief comment (or doc comment) at the top explaining what this module is responsible for and where it fits in the system. Link to the relevant architecture doc section when applicable (e.g., `// See docs/architecture/...v3.md Section 6 for memory architecture`).
- Public interfaces and types: describe the contract, not the implementation. For TypeScript interfaces that agents or MCP servers consume, explain what each field means and when it's used.
- Non-obvious decisions: if you chose approach A over approach B for a reason, leave a comment explaining why. Future readers (including future agent sessions) will benefit from knowing the rationale.
- Complex algorithms or data transformations: if the logic isn't self-evident from reading the code, explain the approach.

**Don't document:**
- Self-evident code. `// increment counter` above `counter++` adds nothing.
- Every private helper function. If the name and signature make the purpose clear, that's sufficient.

**Linking to deeper docs:** When a module implements something described in the architecture document or an ADR, reference it. This creates traceability between the running code and the design decisions that shaped it.

### Testing

Tests are required for all non-trivial functionality. They go through PR review alongside the implementation — not as a separate afterthought.

**Testing philosophy for Phase 1:**

This project has a challenge: much of the interesting behavior involves the Claude Agent SDK, which means real agent calls, context windows, and LLM responses. You cannot meaningfully test that in unit tests. Acknowledge this and test what you *can* test well.

**What to test directly (real logic, no mocks):**
- **Memory store**: SQLite operations, FTS5 search, schema migrations. These are pure data operations — write an entry, search for it, verify results. Use a real in-memory SQLite database, not mocks.
- **Audit store**: JSONL append and read-back. Write events, read them back, verify structure and ordering.
- **Reference resolver**: URI parsing and routing. Given a `standards://coding-standards/typescript` URI, verify it resolves through the three-tier override chain correctly. Given a `file://` URI, verify it reads the right file. Use real files in a temp directory.
- **Identity and scope validation**: Given an agent identity with specific file globs and tool allowlists, verify that scope checks pass and fail correctly. This is pure logic — no SDK dependency.
- **Standards resolution**: Three-tier override chain. System default exists, project override exists, verify the override wins. No override, verify the default is returned.

**What to test with mocks:**
- **Hook behavior**: The PreToolUse and PostToolUse hooks need to verify that scope enforcement blocks disallowed actions and audit logging captures the right events. Mock the tool call inputs and verify the hook outputs (allow/block) and side effects (audit log entries).
- **MCP server tools**: The memory and reference resolver MCP tools wrap the stores. Mock the store layer and verify the MCP tool translates requests and responses correctly.
- **Agent process manager**: Mock the subprocess spawn/kill and verify lifecycle management (start, monitor, stop, error handling).

**What NOT to unit test (test manually or in integration):**
- Actual Claude Agent SDK calls and agent behavior. These require real API calls and are non-deterministic. Test the *harness* (identity, hooks, MCP tools), not the LLM responses.
- Tauri IPC integration. Test the command handlers' logic, but the actual IPC bridge is Tauri's responsibility.
- Frontend components in Phase 1. The UI is minimal and exploratory — invest testing effort in the backend and agent infrastructure.

**Test naming**: Describe the behavior being verified, not the function name. `test_scope_enforcement_blocks_write_outside_file_glob` is better than `test_enforce_scope`.

**Test location**: Tests live next to the code they test. Rust tests in the same file or a `tests/` submodule. TypeScript tests in a `tests/` directory within the `agents/` package, mirroring the source structure.

## Phase 1 Scope (Foundation)

### In Scope
- Tauri 2.0 project scaffolding with Svelte + TypeScript frontend
- SQLite memory store with FTS5 (Rust backend, exposed via Tauri commands)
- JSONL audit store (Rust backend, append-only, per-project)
- Memory MCP server (read/write/search tools)
- Reference resolver MCP tool (resolve URI schemes: file://, standards://, memory://)
- Single agent integration: one Code Agent with identity, scope enforcement, and audit hooks
- Basic UI: project creation, agent status display, memory inspector
- System default standards files (shipped with app)
- Agent identity schema and scope enforcement via PreToolUse hooks

### Not In Scope (Later Phases)
- Coordinator agents and multi-agent orchestration (Phase 2)
- Reference manifest handoff protocol between agents (Phase 2)
- Issue tracker MCP server (Phase 3)
- Workflow engine, parallel execution, approval workflows (Phase 3)
- Semantic search / vector embeddings (Phase 4)
- FIDO-like cryptographic identity (Phase 5)
- Cloud backends for memory or audit

### Key Phase 1 Decision Points
- **JSONL audit scoping**: Decide per-project vs per-session file granularity. Write an ADR.
- **`createSdkMcpServer` verification**: Confirm the in-process MCP pattern works with current SDK version before building on it. If the API has changed, document the delta and adapt.
- **Tauri sidecar setup**: Verify the Claude CLI sidecar bundling works cleanly on the target platform before building the agent process manager around it.

## What Not To Do

- Do not implement summary-based handoffs. The reference manifest pattern is the architecture.
- Do not add vector search, embeddings, or semantic similarity in Phase 1.
- Do not build coordinator agents or multi-agent workflows in Phase 1.
- Do not add cloud dependencies or remote storage.
- Do not skip writing ADRs for decisions that aren't covered by the architecture doc.
- Do not put business logic in the Rust layer — it handles storage and process management. Agent logic lives in TypeScript.
