# Verification: Tauri Sidecar Setup for Agent Process Management

**Date**: 2026-02-25
**Issue**: [#3 — Verify Tauri sidecar setup for Claude CLI](https://github.com/kpcooney/saor/issues/3)
**Tauri Version**: 2.10.2
**Shell Plugin Version**: tauri-plugin-shell 2.3.5

## Summary

The Tauri shell plugin (`tauri-plugin-shell`) provides the process management primitives needed for Saor's agent layer. Two verification commands confirm that Rust can spawn a Node.js subprocess, communicate over stdio, and terminate it cleanly. The build compiles without errors or warnings on macOS.

## What Was Verified

1. **Dependency setup**: `tauri-plugin-shell` integrates cleanly with the existing Tauri scaffold. Added to `Cargo.toml`, initialized in `lib.rs`, and configured in `capabilities/default.json`.

2. **Process spawning (`verify_sidecar`)**: A Tauri command spawns `node -e "..."`, captures structured JSON output from stdout, and collects the termination event when the process exits naturally. Confirms stdio communication works for agent output capture.

3. **Process termination (`verify_sidecar_kill`)**: A Tauri command spawns a long-running Node.js process (infinite heartbeat loop with SIGTERM handler), collects a few messages, then kills it via `child.kill()`. Confirms clean process termination without zombies.

4. **Capabilities/permissions**: The Tauri 2.0 capability system requires explicit permission for shell operations. `shell:allow-spawn` with `cmd: "node"` grants permission to spawn Node.js processes. `shell:allow-stdin-write` enables future stdin communication with agent processes.

## Architecture Clarification

The architecture doc describes the agent layer as a "sidecar," but the implementation pattern is more precisely a **managed subprocess** rather than a Tauri sidecar binary:

- **Tauri sidecar** (`externalBin`): A compiled binary bundled with the app, spawned via `app.shell().sidecar("name")`. Requires platform-specific binaries with target-triple suffixes.
- **Our approach**: Spawn `node` (available on the developer's machine) with the agents script as an argument, via `app.shell().command("node")`. This avoids bundling Node.js or compiling the agent layer into a binary during Phase 1.

Both approaches use the same `tauri-plugin-shell` API for process lifecycle management (spawn, stdio, kill). The difference is only in binary resolution. For production distribution, the agent layer could be compiled via `pkg` into a self-contained binary and registered as a true Tauri sidecar.

## API Notes

### `CommandChild::kill()` Takes Ownership

The `kill()` method on `CommandChild` consumes `self` (takes ownership), meaning you cannot call it inside a loop that also borrows the child. Structure code to break out of the event loop first, then call `kill()`.

```rust
// Collect events in a loop, then kill after breaking
if should_kill {
    child.kill().map_err(|e| format!("Failed to kill: {e}"))?;
    // Drain remaining events from rx after kill
}
```

### Capability Configuration

The `shell:allow-spawn` permission requires specifying allowed commands explicitly. For security, each command that the app is allowed to spawn must be listed:

```json
{
  "identifier": "shell:allow-spawn",
  "allow": [{ "name": "node", "cmd": "node", "args": true, "sidecar": false }]
}
```

## Files Changed

| File | Change |
|------|--------|
| `src-tauri/Cargo.toml` | Added `tauri-plugin-shell = "2"` |
| `src-tauri/src/lib.rs` | Added `verify_sidecar` and `verify_sidecar_kill` commands, registered shell plugin |
| `src-tauri/capabilities/default.json` | Added `shell:allow-spawn` and `shell:allow-stdin-write` permissions |

## Implications for Downstream Issues

- **Issue #11 (Code Agent integration)**: The shell plugin provides the spawn/kill/stdio primitives. The `AgentProcessManager` in `process/manager.rs` will wrap these with session tracking and error handling.
- **Production bundling**: For distribution beyond dev machines, consider compiling the agent layer into a standalone binary via `@yao-pkg/pkg` and registering it as a true Tauri `externalBin` sidecar. This is a future concern, not Phase 1.
