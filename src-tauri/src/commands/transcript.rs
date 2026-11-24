// commands/transcript.rs
//
// Session-transcript IPC command: fetch what an agent said during one session
// (issue #78, ADR-013). It resolves the project's root through the registry
// and reads through the FileSystemTranscriptStore. The plain function takes a
// `&ProjectRegistry` for direct testing; the tauri wrapper adds state-locking
// and error-stringing.
//
// There is no write command: transcripts are written only by a running agent,
// through the storage bridge (bridge/host.rs).

use tauri::State;

use crate::commands::project::RegistryState;
use crate::project::ProjectRegistry;
use crate::transcript::{FileSystemTranscriptStore, TranscriptEntry};

/// Returns a session's transcript within the project, in the order it was
/// written. A session with no transcript yields an empty list.
pub fn for_session(
    registry: &ProjectRegistry,
    project_id: &str,
    session_id: &str,
) -> Result<Vec<TranscriptEntry>, String> {
    let root = registry.path_for(project_id).map_err(|e| e.to_string())?;
    FileSystemTranscriptStore::new(&root)
        .and_then(|store| store.read(session_id))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn agent_transcript(
    registry: State<'_, RegistryState>,
    project_id: String,
    session_id: String,
) -> Result<Vec<TranscriptEntry>, String> {
    let registry = registry.lock().map_err(|e| e.to_string())?;
    for_session(&registry, &project_id, &session_id)
}
