/**
 * agents/src/index.ts
 *
 * Entry point for the Saor agent layer. This package runs as a standalone
 * Node.js process (Tauri sidecar), not in the browser. It initializes the
 * agent harness, registers MCP servers, and exposes the interface through
 * which the Tauri backend can spawn and communicate with SDLC agents.
 *
 * See docs/architecture/sdlc-agent-architecture-research-v4.md for the
 * full agent architecture.
 */

// Exports will be added as each module is implemented in Phase 1.
