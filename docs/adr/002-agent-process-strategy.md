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

**Chosen approach**: Option A (managed subprocess) — Node.js is already a deployment prerequisite (the Claude Agent SDK requires it), so requiring it on the host PATH adds no new dependency. This avoids the build complexity of compiling platform-specific binaries. Both options use the same `tauri-plugin-shell` API for process lifecycle management (spawn, stdio, kill), so this decision can be revisited later if distribution to environments without Node.js becomes a goal.

## Consequences

**Positive:**

- **No binary compilation step.** The development loop is `npm run build` → Tauri spawns `node dist/index.js`. No `pkg` compilation, no target-triple management, no platform-specific binary matrix.
- **Faster iteration.** Changes to the agent layer are picked up immediately after a TypeScript build. No need to recompile a standalone binary.
- **No new dependency.** Node.js is already required by the Claude Agent SDK and the TypeScript build toolchain. Requiring it at runtime adds no new prerequisite.

**Negative / trade-offs:**

- **Runtime dependency on Node.js.** The host machine must have a compatible Node.js version (v20+) on its PATH. If the app is ever distributed to environments without Node.js, this decision would need to be revisited.
- **Version compatibility risk.** The user's installed Node.js version could differ from what the agent layer expects. Mitigated by documenting the minimum version and checking at spawn time.

**Neutral / notable:**

- **Capability configuration.** The `shell:allow-spawn` permission in `capabilities/default.json` must list `node` as an allowed command.
- **`CommandChild::kill()` takes ownership.** The `AgentProcessManager` must break out of the event loop before calling `kill()`, since the method consumes `self`.
- **Reversibility.** Both options use the same `tauri-plugin-shell` API (`spawn`, `stdio`, `kill`). Switching to a compiled sidecar later would require: (1) adding a compilation step (`@yao-pkg/pkg` or similar), (2) registering the binary in `tauri.conf.json` under `bundle.externalBin`, (3) changing `command("node")` to `sidecar("saor-agents")`. No architectural changes needed.

## References

- Issue: [#18 — Housekeeping](https://github.com/kpcooney/saor/issues/18)
- Related issue: [#3 — Verify Tauri sidecar setup](https://github.com/kpcooney/saor/issues/3)
- Verification findings: [docs/verification/003-tauri-sidecar-verification.md](../verification/003-tauri-sidecar-verification.md)
- Architecture doc: [Section 1.4 — Why Only Python/TypeScript SDKs](../architecture/sdlc-agent-architecture-research-v4.md#14-why-only-pythontypescript-sdks)
- Architecture doc: [Section 2.2 — Why Tauri for This Project](../architecture/sdlc-agent-architecture-research-v4.md#22-why-tauri-for-this-project)
- Architecture doc: [Section 2.3 — Architecture Overview](../architecture/sdlc-agent-architecture-research-v4.md#23-architecture-overview)
- Related ADRs: [001 — Audit Store JSONL File Granularity](001-audit-store-scoping.md)
