// transcript/mod.rs
//
// Session transcripts: the per-session record of what an agent was asked, what
// it said, and how the run ended (issue #78, ADR-013). This is what lets the
// UI show a run instead of only a status pill.
//
// A transcript is deliberately not the audit trail. The audit trail records
// what an agent *did* — tool calls, blocks, lifecycle — and is forensic. The
// transcript records what it *said*. A message entry names the tool calls the
// agent made in that turn by id only; the calls themselves stay in the audit
// trail and the UI joins the two, so nothing is stored twice.
//
// Layout:
//   schema.rs — TranscriptEntry, its kinds, and the error type
//   store.rs  — FileSystemTranscriptStore: one append-only JSONL file per
//               session under `{project}/.sdlc/sessions/`
//
// Entries arrive from the running agent through the storage bridge
// (`transcript.append`, bridge/host.rs) and are read by the UI through the
// `agent_transcript` command (commands/transcript.rs).

pub mod schema;
pub mod store;

pub use schema::{TranscriptEntry, TranscriptEntryKind, TranscriptError};
pub use store::FileSystemTranscriptStore;
