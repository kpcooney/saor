/**
 * agents/tests/bridge/line-reader.test.ts
 *
 * Tests for the storage bridge's line splitter (issue #68, ADR-009). The rule
 * under test is narrow and load-bearing: a line ends at `\n` and at nothing
 * else, because that is what the Rust side writes. Splitting anywhere else
 * tears a JSON message apart and leaves its request waiting forever.
 */

import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { readLines } from '../../src/bridge/line-reader.js';

const LINE_SEPARATOR = ' ';
const PARAGRAPH_SEPARATOR = ' ';

/** Start a reader over an in-memory stream and record what it reports. */
function startReader() {
  const input = new PassThrough();
  const lines: string[] = [];
  let closeCount = 0;
  const reader = readLines(input, {
    onLine: (line) => lines.push(line),
    onClose: () => {
      closeCount += 1;
    },
  });
  return { input, lines, reader, closeCount: () => closeCount };
}

/** Resolve once the stream has ended and the reader has reported it. */
async function endAndWait(input: PassThrough, closeCount: () => number): Promise<void> {
  input.end();
  await expect.poll(closeCount).toBe(1);
}

describe('readLines', () => {
  it('delivers each newline-terminated line without its terminator', async () => {
    const { input, lines, closeCount } = startReader();

    input.write('first\nsecond\n');
    await endAndWait(input, closeCount);

    expect(lines).toEqual(['first', 'second']);
  });

  it('does not end a line at U+2028 or U+2029', async () => {
    const { input, lines, closeCount } = startReader();
    const message = JSON.stringify({ content: `a${LINE_SEPARATOR}b${PARAGRAPH_SEPARATOR}c` });
    // The premise: JSON leaves both characters unescaped, so they are on the wire.
    expect(message).toContain(LINE_SEPARATOR);
    expect(message).toContain(PARAGRAPH_SEPARATOR);

    input.write(`${message}\n`);
    await endAndWait(input, closeCount);

    expect(lines).toEqual([message]);
  });

  it('does not end a line at a bare carriage return, vertical tab, form feed, or NEL', async () => {
    const { input, lines, closeCount } = startReader();
    const line = 'a\rb\u000bc\u000cd\u0085e';

    input.write(`${line}\n`);
    await endAndWait(input, closeCount);

    expect(lines).toEqual([line]);
  });

  it('joins a line that arrives in several chunks', async () => {
    const { input, lines, closeCount } = startReader();

    input.write('{"part":');
    input.write('"one"}\n{"part"');
    input.write(':"two"}\n');
    await endAndWait(input, closeCount);

    expect(lines).toEqual(['{"part":"one"}', '{"part":"two"}']);
  });

  it('keeps a multi-byte character intact when a chunk boundary splits it', async () => {
    const { input, lines, closeCount } = startReader();
    const bytes = Buffer.from(`café ${LINE_SEPARATOR} \u{1f600}\n`, 'utf8');

    // One byte per chunk splits every multi-byte character there is.
    for (const byte of bytes) {
      input.write(Buffer.from([byte]));
    }
    await endAndWait(input, closeCount);

    expect(lines).toEqual([`café ${LINE_SEPARATOR} \u{1f600}`]);
  });

  it('delivers a line longer than a pipe buffer in one piece', async () => {
    const { input, lines, closeCount } = startReader();
    const longLine = JSON.stringify({ content: `x${LINE_SEPARATOR}`.repeat(200_000) });

    // 16 KiB writes, as a pipe would hand them over.
    const bytes = Buffer.from(`${longLine}\n`, 'utf8');
    for (let offset = 0; offset < bytes.length; offset += 16_384) {
      input.write(bytes.subarray(offset, offset + 16_384));
    }
    await endAndWait(input, closeCount);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(longLine);
  });

  it('delivers empty lines as empty strings', async () => {
    const { input, lines, closeCount } = startReader();

    input.write('a\n\nb\n');
    await endAndWait(input, closeCount);

    expect(lines).toEqual(['a', '', 'b']);
  });

  it('delivers trailing text as a last line when the stream ends without a newline', async () => {
    const { input, lines, closeCount } = startReader();

    input.write('complete\nunterminated');
    await endAndWait(input, closeCount);

    expect(lines).toEqual(['complete', 'unterminated']);
  });

  it('reports the end of the stream exactly once', async () => {
    const { input, reader, closeCount } = startReader();

    await endAndWait(input, closeCount);
    reader.close();
    input.destroy();
    await new Promise((resolve) => setImmediate(resolve));

    expect(closeCount()).toBe(1);
  });

  it('close() stops delivery and reports the close exactly once', async () => {
    const { input, lines, reader, closeCount } = startReader();

    input.write('before\n');
    await expect.poll(() => lines.length).toBe(1);
    reader.close();
    reader.close();
    input.write('after\n');
    await new Promise((resolve) => setImmediate(resolve));

    expect(lines).toEqual(['before']);
    expect(closeCount()).toBe(1);
  });

  it('delivers nothing further when closed from inside onLine', async () => {
    const input = new PassThrough();
    const lines: string[] = [];
    const reader = readLines(input, {
      onLine: (line) => {
        lines.push(line);
        reader.close();
      },
      onClose: () => undefined,
    });

    input.write('one\ntwo\nthree\n');
    await expect.poll(() => lines.length).toBeGreaterThan(0);
    await new Promise((resolve) => setImmediate(resolve));

    expect(lines).toEqual(['one']);
  });

  it('treats a stream error as the end of the stream instead of throwing', async () => {
    const { input, closeCount } = startReader();

    input.destroy(new Error('pipe broke'));

    await expect.poll(closeCount).toBe(1);
  });
});
