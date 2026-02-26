# 002 — Agent Layer Process Strategy

**Status**: proposed

## Context

The architecture document (Section 2.2, item 5) describes the TypeScript agent layer as a "sidecar" that Tauri manages. Tauri offers two process management patterns, and the choice affects build complexity, distribution requirements, and developer experience during Phase 1.

The Claude Agent SDK is a TypeScript package that spawns Claude CLI subprocesses and communicates over stdio. The agent layer must run as a standalone Node.js process — it cannot run inside the browser context. The question is how Tauri launches and manages that process.

This decision was surfaced during Issue #3 (Tauri sidecar verification, PR #17) when we confirmed that `tauri-plugin-shell` provides the spawn/stdio/kill primitives for both approaches. The verification findings are documented in `docs/verification/003-tauri-sidecar-verification.md`.

## Decision

**Options considered:**

- **Option A: Managed subprocess** — Tauri spawns `node` (expected on the developer's PATH) with the agent entry script as an argument, via `app.shell().command("node")`. No binary bundling. Requires Node.js installed on the host machine.

- **Option B: Compiled sidecar binary** — The agent TypeScript package is compiled into a self-contained executable (e.g., via `@yao-pkg/pkg`) and registered as a Tauri `externalBin` sidecar. Launched via `app.shell().sidecar("saor-agents")`. Requires platform-specific binaries with target-triple suffixes (`saor-agents-x86_64-apple-darwin`, etc.).

- **Option C: Hybrid** — Use Option A (managed subprocess) during development and Phase 1, with Option B (compiled sidecar) as the distribution path for later phases when the app ships to users who may not have Node.js installed.

**Chosen approach**: Option C (hybrid) — managed subprocess for Phase 1, compiled sidecar as upgrade path. Both approaches use the same `tauri-plugin-shell` API for process lifecycle management (spawn, stdio, kill). The difference is only binary resolution. This avoids premature build complexity while keeping the distribution path open.

## Consequences

**Positive:**

- **No binary compilation step in Phase 1.** The development loop is `npm run build` → Tauri spawns `node dist/index.js`. No `pkg` compilation, no target-triple management, no platform-specific binary matrix.
- **Faster iteration.** Changes to the agent layer are picked up immediately after a TypeScript build. No need to recompile a standalone binary.
- **Same API surface.** Both `app.shell().command("node")` and `app.shell().sidecar("name")` return `(Receiver<CommandEvent>, CommandChild)` with identical event types (`Stdout`, `Stderr`, `Terminated`). The `AgentProcessManager` abstraction does not need to change when upgrading.
- **Node.js is a reasonable Phase 1 prerequisite.** The developers working on Saor during Phase 1 already have Node.js installed. This is a developer tool, not an end-user product yet.

**Negative / trade-offs:**

- **Runtime dependency on Node.js.** The host machine must have a compatible Node.js version (v20+) on its PATH. This is acceptable for development but not for end-user distribution.
- **No self-contained binary.** The app cannot be distributed as a single package without also requiring Node.js installation. This limits Phase 1 to developer use, which is the intended audience.
- **Version compatibility risk.** The user's installed Node.js version could differ from what the agent layer expects. Mitigated by documenting the minimum version and checking at spawn time.

**Neutral / notable:**

- **Capability configuration is the same.** The `shell:allow-spawn` permission in `capabilities/default.json` must list `node` as an allowed command. For a compiled sidecar, it would list the binary name instead. The security model is unchanged.
- **`CommandChild::kill()` takes ownership** in both patterns. The `AgentProcessManager` must account for this regardless of spawn method (break out of event loop before calling `kill()`).
- **Upgrade path is mechanical.** When ready for distribution: (1) add `pkg` or similar to the agent build pipeline, (2) register the output binary in `tauri.conf.json` under `bundle.externalBin`, (3) change `app.shell().command("node")` to `app.shell().sidecar("saor-agents")`, (4) update capability permissions. No architectural changes needed.

## References

- Issue: [#18 — Housekeeping](https://github.com/kpcooney/saor/issues/18)
- Related issue: [#3 — Verify Tauri sidecar setup](https://github.com/kpcooney/saor/issues/3)
- Verification findings: [docs/verification/003-tauri-sidecar-verification.md](../verification/003-tauri-sidecar-verification.md)
- Architecture doc: [Section 1.4 — Why Only Python/TypeScript SDKs](../architecture/sdlc-agent-architecture-research-v4.md#14-why-only-pythontypescript-sdks)
- Architecture doc: [Section 2.2 — Why Tauri for This Project](../architecture/sdlc-agent-architecture-research-v4.md#22-why-tauri-for-this-project)
- Architecture doc: [Section 2.3 — Architecture Overview](../architecture/sdlc-agent-architecture-research-v4.md#23-architecture-overview)
- Related ADRs: [001 — Audit Store JSONL File Granularity](001-audit-store-scoping.md)
