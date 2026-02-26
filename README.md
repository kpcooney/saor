# Saor

*seer* — Irish Gaelic, noun

In early Irish society, a saor was a master craftsman of a specific kind — not merely someone who could execute skilled work, but someone whose mastery was broad enough to conceive, plan, execute, and judge the work from start to finish. The saor understood the full arc of what needed to be made.

Crucially, this mastery conferred status and independence. In Old Irish, saor carries a dual meaning that was not accidental: skilled craftsman and free person were the same concept. To truly master a craft was to be free — you could not just follow instructions, you had to understand deeply enough to make decisions for yourself.

Saor is an AI-powered SDLC orchestrator that coordinates specialist agents through the full software development lifecycle — from requirements and architecture through implementation, testing, and deployment. Like its namesake, it doesn't just execute tasks. It understands the whole process well enough to coordinate it.

---

Built with Tauri 2.0 (Rust backend), Svelte + TypeScript (frontend), and the Claude Agent SDK (TypeScript agent layer).

## Prerequisites

- **Node.js** v20+ and npm
- **Rust** (latest stable) via [rustup](https://rustup.rs/)
- **Tauri CLI**: installed as a dev dependency (`@tauri-apps/cli`), run via `npm run tauri`
- **System WebView**: Tauri uses the OS WebView (WebKit on macOS, WebView2 on Windows). macOS has it built in. On Windows, WebView2 may need to be installed.

## Getting Started

```bash
# Clone and install frontend + agent dependencies
git clone https://github.com/kpcooney/saor.git
cd saor
npm install
cd agents && npm install && cd ..
```

## Build & Run

```bash
# Run the full app (frontend dev server + Rust backend)
npm run tauri dev

# Build for production
npm run tauri build
```

## Test

```bash
# Rust backend (from src-tauri/)
cd src-tauri
cargo test
cargo clippy          # lint
cargo fmt --check     # format check

# TypeScript agents (from agents/)
cd agents
npm test              # vitest

# Frontend type checking (from root)
npm run check
```

## Project Structure

```
src-tauri/      Rust backend — storage, process management, IPC
src/            Svelte + TypeScript frontend
agents/         TypeScript agent layer — definitions, hooks, MCP servers
standards/      System default standards files (three-tier base layer)
docs/           Architecture docs, ADRs, verification reports
```

Each directory has its own README with more detail. The authoritative architecture reference is `docs/architecture/sdlc-agent-architecture-research-v4.md`.
