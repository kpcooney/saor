/**
 * agents/src/bridge/line-reader.ts
 *
 * Splits a byte stream into the storage bridge's protocol lines (ADR-009).
 *
 * A bridge line ends at a line feed (`\n`, 0x0A) and at nothing else. That is
 * the rule the Rust side writes and reads by, and it is safe because JSON
 * always escapes a line feed inside a string, so one can never appear in the
 * middle of a message.
 *
 * `node:readline` is deliberately not used here. It also ends a line at
 * U+2028 (LINE SEPARATOR) and U+2029 (PARAGRAPH SEPARATOR), which JSON does
 * not escape. A response carrying either character — a resolved file, a memory
 * entry — would reach the client in pieces, none of them valid JSON, and the
 * request waiting for it would never settle (issue #68).
 */

import { StringDecoder } from 'node:string_decoder';
import type { Readable } from 'node:stream';

const LINE_FEED = '\n';

/** What a {@link LineReader} reports to its owner. */
export interface LineReaderHandlers {
  /** Called once per complete line, without its terminating line feed. */
  readonly onLine: (line: string) => void;
  /**
   * Called exactly once, when no more lines will be delivered: the stream
   * ended, failed, or {@link LineReader.close} was called.
   */
  readonly onClose: () => void;
}

/** A running line reader. */
export interface LineReader {
  /**
   * Stop reading. Idempotent. The stream is paused so that an open pipe (the
   * sidecar's stdin) no longer keeps the process alive.
   */
  close(): void;
}

/**
 * Read `input` as newline-terminated lines.
 *
 * Text left over when the stream ends without a final line feed is delivered
 * as a last line, so a writer that omits the trailing newline loses nothing.
 */
export function readLines(input: Readable, handlers: LineReaderHandlers): LineReader {
  // Decodes across chunk boundaries, so a multi-byte character split between
  // two chunks is not corrupted.
  const decoder = new StringDecoder('utf8');
  // The pieces of the line currently being received. Kept as pieces so a long
  // line arriving in many chunks is joined once, not re-scanned per chunk.
  let partialLine: string[] = [];
  let isClosed = false;

  function acceptText(text: string): void {
    const segments = text.split(LINE_FEED);
    // Every segment but the last was followed by a line feed, so it completes
    // a line. The last one is the start of the next line (often empty).
    const unterminated = segments.pop() ?? '';
    for (const segment of segments) {
      partialLine.push(segment);
      const line = partialLine.join('');
      partialLine = [];
      handlers.onLine(line);
      if (isClosed) {
        // The owner closed the reader from inside onLine; deliver nothing more.
        return;
      }
    }
    if (unterminated.length > 0) {
      partialLine.push(unterminated);
    }
  }

  function onData(chunk: Buffer | string): void {
    acceptText(typeof chunk === 'string' ? chunk : decoder.write(chunk));
  }

  function finish(): void {
    if (isClosed) {
      return;
    }
    isClosed = true;
    input.off('data', onData);
    input.off('end', onEnd);
    input.off('close', finish);
    // The 'error' listener stays attached: finish() is idempotent, and a pipe
    // that fails after the reader closed must not become an uncaught exception.
    handlers.onClose();
  }

  function onEnd(): void {
    if (isClosed) {
      return;
    }
    const remainder = partialLine.join('') + decoder.end();
    partialLine = [];
    if (remainder.length > 0) {
      handlers.onLine(remainder);
    }
    finish();
  }

  input.on('data', onData);
  input.on('end', onEnd);
  // A destroyed or failed stream delivers nothing more either. Listening for
  // 'error' also keeps a broken pipe from surfacing as an uncaught exception.
  input.on('close', finish);
  input.on('error', finish);

  return {
    close(): void {
      if (isClosed) {
        return;
      }
      finish();
      input.pause();
    },
  };
}
