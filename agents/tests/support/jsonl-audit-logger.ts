/**
 * agents/tests/support/jsonl-audit-logger.ts
 *
 * A real, file-backed AuditLogger for the Code Agent integration test (#11).
 * It is not a mock: `log()` appends the event as a JSON line to a temp file,
 * and `readAuditEvents()` reads it back by parsing the file — so a test asserts
 * on side effects actually persisted to disk, per the acceptance-check
 * intent ("real temp-JSONL audit store", side effects read back).
 *
 * This is deliberately test-only. The production JSONL audit store lives in
 * Rust (issue #5); the concrete TS AuditLogger that transports events to it
 * over IPC lands with issue #12. The Code Agent wiring depends only on the
 * `AuditLogger` port, so this stand-in exercises the same contract.
 */

import { appendFileSync, readFileSync } from 'node:fs';

import type { AuditEvent, AuditLogger } from '../../src/hooks/audit-logger.js';

/** An AuditLogger that appends one JSON-encoded event per line to a file. */
export class JsonlAuditLogger implements AuditLogger {
  constructor(private readonly filePath: string) {}

  async log(event: AuditEvent): Promise<void> {
    appendFileSync(this.filePath, `${JSON.stringify(event)}\n`, 'utf8');
  }
}

/**
 * Read every audit event back from a JSONL file, in insertion order. Returns an
 * empty array when the file does not exist yet (nothing has been logged).
 */
export function readAuditEvents(filePath: string): AuditEvent[] {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  return raw
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as AuditEvent);
}
