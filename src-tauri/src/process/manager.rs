// process/manager.rs
//
// AgentProcessManager — owns the lifecycle of running agent processes.
// Tracks active agent sessions (agent identity, process handle, start time),
// provides start/stop/status operations, and forwards stdout/stderr from
// agent processes to the audit log and the frontend UI.
//
// In Phase 1, this manages a single Code Agent process at a time. In Phase 2,
// it will manage multiple concurrent agents (coordinator + specialists) with
// the same interface.
//
// Key responsibilities:
//   - Spawn the agent sidecar with the correct environment (project path,
//     agent identity, MCP server configuration)
//   - Monitor process health and detect unexpected exits
//   - Surface status changes to the frontend via Tauri events
//   - Ensure clean shutdown (allow in-flight tool calls to complete)
//
// See docs/architecture/sdlc-agent-architecture-research-v4.md Section 2.3
// for the sidecar architecture and Section 1.4 for why the SDK runs as
// a separate process rather than in the Rust layer directly.

// Implementation coming in Phase 1 agent process management work.
