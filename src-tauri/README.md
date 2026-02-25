# src-tauri/

This is the Rust backend, following Tauri's standard convention where the native backend lives in `src-tauri/`. It was created by `cargo tauri init` and contains the app entry point, Tauri configuration, and all the Rust modules that power Saor's backend services.

**What it is responsible for:**
- **SQLite memory store** (`memory/`) — stores agent learnings, project metadata, and a cross-cutting knowledge index, with FTS5 full-text search
- **JSONL audit store** (`audit/`) — append-only event log capturing every agent action, scope violation, and lifecycle event
- **Reference resolver** (`references/`) — resolves URI schemes (`file://`, `standards://`, `memory://`, `audit://`) used in agent reference manifests
- **Agent identity and scope validation** (`identity/`) — validates `AgentIdentity` structs and enforces file glob and tool allowlist restrictions
- **Agent process lifecycle** (`process/`) — spawns, monitors, and terminates the TypeScript agent sidecar processes
- **IPC command handlers** (`src/lib.rs`) — Tauri `#[tauri::command]` functions that bridge frontend `invoke()` calls to the modules above

**What it is NOT responsible for:** Agent business logic, agent orchestration, and MCP server definitions. Those live in the `agents/` TypeScript package. The Rust layer is deliberately thin — stable infrastructure that doesn't change often, so that iteration happens in the agent layer where the interesting work is.

**IPC** stands for inter-process communication. The Svelte frontend calls `invoke("command_name", args)`, which crosses the WebView-to-Rust process boundary via Tauri's IPC bridge and returns a serialized result. Every Tauri command is registered in `lib.rs` via `invoke_handler`.
