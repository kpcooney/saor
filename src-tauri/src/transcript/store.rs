// transcript/store.rs
//
// FileSystemTranscriptStore — session transcripts as append-only JSONL, one
// file per session at `{project_path}/.sdlc/sessions/{session_id}.jsonl`
// (ADR-013). Each line is one serialized TranscriptEntry, in the order the
// agent produced them.
//
// One file per session, rather than the audit trail's one file per day,
// because a transcript is only ever read whole and by session: the session
// view opens exactly one. The session id is therefore a file name, and is
// validated before it is used as one.
//
// `.sdlc/` is outside every agent's file scope and hidden from its shell by
// the sandbox, so a running agent cannot read or rewrite its own transcript;
// it can only append through the storage bridge.

use std::fs;
use std::io::{BufRead, BufReader, ErrorKind};
use std::path::{Path, PathBuf};

use super::schema::{TranscriptEntry, TranscriptError};
use crate::jsonl::append_line;

/// Longest session id accepted as a file name. Generated ids
/// (`session-<uuid>`) are 44 characters.
const MAX_SESSION_ID_LEN: usize = 128;

/// Append-only per-session transcript files under
/// `{project_path}/.sdlc/sessions/`.
pub struct FileSystemTranscriptStore {
    sessions_dir: PathBuf,
}

impl FileSystemTranscriptStore {
    /// Creates a store rooted at `{project_path}/.sdlc/sessions/`, creating
    /// the directory if it doesn't exist.
    pub fn new(project_path: &Path) -> Result<Self, TranscriptError> {
        let sessions_dir = project_path.join(".sdlc").join("sessions");
        fs::create_dir_all(&sessions_dir).map_err(|e| {
            TranscriptError::DirectoryCreation(format!(
                "failed to create {}: {e}",
                sessions_dir.display()
            ))
        })?;
        Ok(Self { sessions_dir })
    }

    /// Appends one entry to the transcript of the session it names.
    pub fn append(&self, entry: &TranscriptEntry) -> Result<(), TranscriptError> {
        let path = self.session_file(&entry.session_id)?;
        let json = serde_json::to_string(entry)?;
        append_line(&path, &json)?;
        Ok(())
    }

    /// Returns a session's transcript in the order it was written. A session
    /// with no transcript — one that never started, or predates transcripts —
    /// yields an empty list rather than an error.
    ///
    /// A line that does not parse (a write torn by a crash, a manual edit) is
    /// skipped, so one bad line never hides the rest of a run. Unlike the
    /// audit trail the transcript is a reading aid, not forensic evidence, so
    /// skipped lines are not reported.
    pub fn read(&self, session_id: &str) -> Result<Vec<TranscriptEntry>, TranscriptError> {
        let path = self.session_file(session_id)?;
        let file = match fs::File::open(&path) {
            Ok(file) => file,
            Err(e) if e.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(e.into()),
        };

        let mut entries = Vec::new();
        for line in BufReader::new(file).lines() {
            let line = line?;
            if let Ok(entry) = serde_json::from_str::<TranscriptEntry>(&line) {
                entries.push(entry);
            }
        }
        Ok(entries)
    }

    /// The transcript file for a session, refusing an id that is not a plain
    /// file-name component.
    fn session_file(&self, session_id: &str) -> Result<PathBuf, TranscriptError> {
        if !is_valid_session_id(session_id) {
            return Err(TranscriptError::InvalidSessionId(session_id.to_string()));
        }
        Ok(self.sessions_dir.join(format!("{session_id}.jsonl")))
    }
}

/// True for an id that is safe to use as a file name: non-empty, bounded, and
/// made only of ASCII letters, digits, `-` and `_`. That excludes every path
/// separator and `.`, so an id cannot name a file outside the sessions
/// directory.
fn is_valid_session_id(session_id: &str) -> bool {
    !session_id.is_empty()
        && session_id.len() <= MAX_SESSION_ID_LEN
        && session_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

#[cfg(test)]
mod tests {
    use super::super::schema::TranscriptEntryKind;
    use super::*;
    use serde_json::json;

    fn entry(session_id: &str, kind: TranscriptEntryKind, text: &str) -> TranscriptEntry {
        TranscriptEntry {
            session_id: session_id.to_string(),
            timestamp: "2026-11-24T02:39:40.000Z".to_string(),
            kind,
            text: text.to_string(),
            details: json!({}),
        }
    }

    #[test]
    fn test_entries_read_back_in_the_order_they_were_appended() {
        let tmp = tempfile::tempdir().unwrap();
        let store = FileSystemTranscriptStore::new(tmp.path()).unwrap();

        store
            .append(&entry("session-a", TranscriptEntryKind::Task, "Add a page"))
            .unwrap();
        store
            .append(&entry(
                "session-a",
                TranscriptEntryKind::Message,
                "Looking.",
            ))
            .unwrap();
        store
            .append(&entry("session-a", TranscriptEntryKind::Result, "Done."))
            .unwrap();

        let transcript = store.read("session-a").unwrap();
        assert_eq!(
            transcript
                .iter()
                .map(|e| e.text.as_str())
                .collect::<Vec<_>>(),
            vec!["Add a page", "Looking.", "Done."]
        );
        assert_eq!(transcript[0].kind, TranscriptEntryKind::Task);
        assert_eq!(transcript[2].kind, TranscriptEntryKind::Result);
    }

    #[test]
    fn test_each_session_has_its_own_transcript() {
        let tmp = tempfile::tempdir().unwrap();
        let store = FileSystemTranscriptStore::new(tmp.path()).unwrap();

        store
            .append(&entry("session-a", TranscriptEntryKind::Message, "from a"))
            .unwrap();
        store
            .append(&entry("session-b", TranscriptEntryKind::Message, "from b"))
            .unwrap();

        let a = store.read("session-a").unwrap();
        assert_eq!(a.len(), 1);
        assert_eq!(a[0].text, "from a");
        assert!(tmp
            .path()
            .join(".sdlc")
            .join("sessions")
            .join("session-b.jsonl")
            .is_file());
    }

    #[test]
    fn test_a_session_with_no_transcript_reads_as_empty() {
        let tmp = tempfile::tempdir().unwrap();
        let store = FileSystemTranscriptStore::new(tmp.path()).unwrap();

        assert!(store.read("session-never-ran").unwrap().is_empty());
    }

    #[test]
    fn test_a_session_id_that_is_not_a_plain_file_name_is_refused() {
        let tmp = tempfile::tempdir().unwrap();
        let store = FileSystemTranscriptStore::new(tmp.path()).unwrap();
        let too_long = "a".repeat(MAX_SESSION_ID_LEN + 1);

        for bad in [
            "",
            "../audit/2026-11-24",
            "a/b",
            "a\\b",
            "session.1",
            &too_long,
        ] {
            assert!(
                matches!(store.read(bad), Err(TranscriptError::InvalidSessionId(_))),
                "read accepted {bad:?}"
            );
            assert!(
                matches!(
                    store.append(&entry(bad, TranscriptEntryKind::Message, "x")),
                    Err(TranscriptError::InvalidSessionId(_))
                ),
                "append accepted {bad:?}"
            );
        }

        // Negative control: a generated-style id is accepted, and the refused
        // appends above wrote nothing anywhere under the project.
        assert!(store
            .read("session-2a775c54-459f-4030-9ae4-9b8e4754ecf9")
            .is_ok());
        let sessions = tmp.path().join(".sdlc").join("sessions");
        assert_eq!(fs::read_dir(&sessions).unwrap().count(), 0);
        assert!(!tmp.path().join(".sdlc").join("audit").exists());
    }

    #[test]
    fn test_an_unparseable_line_is_skipped_and_costs_no_other_entry() {
        let tmp = tempfile::tempdir().unwrap();
        let store = FileSystemTranscriptStore::new(tmp.path()).unwrap();
        store
            .append(&entry("session-a", TranscriptEntryKind::Message, "before"))
            .unwrap();

        // A write torn by a crash: a partial entry with no trailing newline.
        let path = tmp
            .path()
            .join(".sdlc")
            .join("sessions")
            .join("session-a.jsonl");
        let mut raw = fs::read_to_string(&path).unwrap();
        raw.push_str("{\"sessionId\":\"session-a\",\"timest");
        fs::write(&path, raw).unwrap();

        store
            .append(&entry("session-a", TranscriptEntryKind::Message, "after"))
            .unwrap();

        let transcript = store.read("session-a").unwrap();
        assert_eq!(
            transcript
                .iter()
                .map(|e| e.text.as_str())
                .collect::<Vec<_>>(),
            vec!["before", "after"]
        );
    }
}
