# src/

This is the Svelte + TypeScript frontend, following Tauri's standard convention where the frontend source lives in `src/`. It communicates with the Rust backend via Tauri's `invoke()` IPC (inter-process communication) — the frontend calls `invoke("command_name", args)`, which crosses the process boundary into Rust and returns a result.

In Phase 1, the UI is intentionally minimal — it is infrastructure, not a polished product. It provides: project creation (bootstrapping a new `.sdlc/` project directory and SQLite database), agent status display (what agents are running, their current task), a memory inspector (browse and search memory entries), and an audit viewer (see what agents have done). The interesting engineering in Saor lives in the agent coordination layer (`agents/`) and the Rust backend (`src-tauri/`); the frontend is a window into that system. Svelte 5 runes syntax (`$state`, `$derived`, `$effect`) is used throughout.
