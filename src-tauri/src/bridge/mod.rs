// bridge/mod.rs
//
// The Node↔Rust storage bridge (issue #59, ADR-009). A launched agent sidecar
// is a Node subprocess and cannot call Tauri `invoke`, so it reaches the
// Rust-owned memory store, audit store, reference resolver, and session
// transcript through this bridge instead: line-delimited JSON over the sidecar's own stdio.
//
//   sidecar stdout ──▶ one JSON request per line  ──▶ BridgeHost::handle_line
//   sidecar stdin  ◀── one JSON response per line ◀──┘
//
// Layout:
//   protocol.rs — the wire types: request/response envelopes, error codes,
//                 status lines, and the camelCase memory-entry shape
//   host.rs     — BridgeHost, which services one request line against the
//                 stores of the single session/project it is bound to
//
// Everything here is a pure "line in → line out" function over real stores,
// with no Tauri dependency, so it is tested in a plain `cargo test` (unit
// tests in host.rs, plus src-tauri/tests/storage_bridge.rs which drives it
// from a real Node process). The only Tauri-dependent part is the forwarding
// loop in process/spawner.rs.
//
// The methods are storage primitives only. Anything that composes them — for
// example the `memory_context` orientation summary — lives in the TypeScript
// agent layer (agents/src/bridge/), so no agent logic sits in Rust.
//
// See docs/adr/009-agent-storage-bridge-transport.md for the transport
// decision and the wire format, and
// docs/architecture/sdlc-agent-architecture-research-v4.md Section 2.3 for
// the frontend↔Rust↔agent communication flow.

pub mod host;
pub mod protocol;

pub use host::{BridgeHost, LineOutcome};
pub use protocol::{BridgeError, BridgeErrorCode, SidecarStatus, WireMemoryEntry};
