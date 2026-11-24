// jsonl.rs
//
// The one append primitive shared by the stores that keep JSONL files: the
// audit trail (audit/store.rs) and the session transcripts
// (transcript/store.rs). Both are append-only records where losing a line is
// not acceptable, so the rule for how a line is added lives in one place.
//
// Torn lines: a crash mid-write can leave a file ending in a partial line with
// no trailing newline. Appending straight onto that fragment would glue the
// new record to it, and the combined line would fail to parse — losing a valid
// record (issue #74). So when the file is non-empty and does not end in a
// newline, the write starts with one. The fragment stays on its own line,
// where each store's read path reports or skips it, and the new record lands
// intact on the next.
//
// Concurrency: Phase 1 runs a single agent at a time, so nothing here
// serializes writers. The separator and the record go out as one `write_all`
// of a pre-built buffer, but POSIX `O_APPEND` makes a single `write()` call
// atomic only up to `PIPE_BUF` (~4 KiB on most systems) and `write_all` may
// issue several for a large record — so concurrent multi-process callers could
// still interleave one record's bytes. The torn-line check is likewise
// check-then-write, not atomic with the append. A lock is deferred until
// concurrent agents become a real Phase 2 requirement.

use std::fs::{File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::Path;

/// Appends `json` as one line to the file at `path`, creating the file if it
/// does not exist. `json` must be a single line (serialized JSON never contains
/// a raw newline).
pub fn append_line(path: &Path, json: &str) -> io::Result<()> {
    // `read` is needed only to inspect the last byte; `append` still sends
    // every write to the end of the file.
    let mut file = OpenOptions::new()
        .create(true)
        .read(true)
        .append(true)
        .open(path)?;

    let mut line = String::with_capacity(json.len() + 2);
    if ends_with_unterminated_line(&mut file)? {
        line.push('\n');
    }
    line.push_str(json);
    line.push('\n');
    file.write_all(line.as_bytes())
}

/// Reports whether `file` is non-empty and its last byte is not a newline —
/// i.e. it ends in a partial line left by an interrupted write. An empty file
/// has no line to terminate, so it returns false.
fn ends_with_unterminated_line(file: &mut File) -> io::Result<bool> {
    if file.metadata()?.len() == 0 {
        return Ok(false);
    }
    file.seek(SeekFrom::End(-1))?;
    let mut last_byte = [0u8; 1];
    file.read_exact(&mut last_byte)?;
    Ok(last_byte[0] != b'\n')
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn test_append_line_writes_one_terminated_line_per_call() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("records.jsonl");

        append_line(&path, r#"{"n":1}"#).unwrap();
        append_line(&path, r#"{"n":2}"#).unwrap();

        assert_eq!(fs::read_to_string(&path).unwrap(), "{\"n\":1}\n{\"n\":2}\n");
    }

    #[test]
    fn test_append_line_starts_a_new_line_after_an_unterminated_fragment() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("records.jsonl");
        fs::write(&path, "{\"n\":1}\n{\"n\":").unwrap();

        append_line(&path, r#"{"n":3}"#).unwrap();

        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "{\"n\":1}\n{\"n\":\n{\"n\":3}\n"
        );
    }
}
