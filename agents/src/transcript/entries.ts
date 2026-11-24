/**
 * agents/src/transcript/entries.ts
 *
 * Session-transcript entries (issue #78, ADR-013): the record of what an agent
 * was asked, what it said, and how the run ended. The sidecar builds these from
 * the SDK's message stream and sends them to the Rust-owned transcript store,
 * which is what lets the UI show a run rather than only a status pill.
 *
 * The transcript holds what the agent *said*, not what it did. A tool call is
 * already in the audit trail, written by the hooks, so a message entry carries
 * only the ids of the calls made in that turn (`details.toolUseIds`). The UI
 * joins the two on that id; nothing is stored twice.
 *
 * Entry shapes mirror `TranscriptEntry` in src-tauri/src/transcript/schema.rs,
 * minus `sessionId`: the Rust side files every entry under the session its
 * bridge is bound to, so the sidecar never names one.
 */

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

/** What a transcript entry records. */
export type TranscriptEntryKind = 'task' | 'message' | 'result';

/** One transcript entry, as the sidecar sends it over the bridge. */
export interface TranscriptEntry {
  /** ISO-8601 time the sidecar observed the message. */
  readonly timestamp: string;
  readonly kind: TranscriptEntryKind;
  /**
   * `task`: the launch task. `message`: what the agent said this turn (empty
   * when the turn was only tool calls). `result`: its final answer, or the
   * error the run ended with.
   */
  readonly text: string;
  /** Kind-specific context; see {@link messageEntryFrom} and {@link resultEntry}. */
  readonly details: Record<string, unknown>;
}

/** The facts about a finished run that a `result` entry records. */
export interface RunResultSummary {
  /** The agent's final answer, or the error message. */
  readonly text: string;
  readonly isError: boolean;
  readonly numTurns?: number;
  readonly durationMs?: number;
  readonly totalCostUsd?: number;
}

/**
 * Where transcript entries go. `record` never throws and never rejects: a
 * transcript is a reading aid, and losing an entry must not fail an agent run.
 */
export interface TranscriptRecorder {
  /** Queue one entry. Entries are stored in the order they are recorded. */
  record(entry: TranscriptEntry): void;
  /** Resolve once every recorded entry has been stored or given up on. */
  flush(): Promise<void>;
}

/** The entry that opens a transcript: the task the agent was launched with. */
export function taskEntry(task: string, now: Date): TranscriptEntry {
  return { timestamp: now.toISOString(), kind: 'task', text: task, details: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The entry for one SDK message, or `undefined` when the message is not the
 * agent speaking. Only `assistant` messages qualify: their text blocks become
 * the entry's text (joined by a blank line) and their tool-use blocks become
 * `details.toolUseIds`, in the order the agent made the calls.
 *
 * An assistant message with neither text nor tool calls (a thinking-only
 * turn) yields nothing. The final `result` message is not handled here — the
 * sidecar records the outcome once, from whatever ended the run (see
 * {@link resultEntry}).
 */
export function messageEntryFrom(message: SDKMessage, now: Date): TranscriptEntry | undefined {
  if (message.type !== 'assistant') {
    return undefined;
  }
  // The content blocks are read defensively: this is a boundary with the SDK,
  // and a block shape this code does not know must be skipped, not thrown on.
  const content: unknown = message.message.content;
  const blocks: readonly unknown[] = Array.isArray(content) ? content : [];

  const texts: string[] = [];
  const toolUseIds: string[] = [];
  for (const block of blocks) {
    if (!isRecord(block)) {
      continue;
    }
    if (block['type'] === 'text' && typeof block['text'] === 'string') {
      const text = block['text'].trim();
      if (text.length > 0) {
        texts.push(text);
      }
    } else if (block['type'] === 'tool_use' && typeof block['id'] === 'string') {
      toolUseIds.push(block['id']);
    }
  }

  if (texts.length === 0 && toolUseIds.length === 0) {
    return undefined;
  }
  return {
    timestamp: now.toISOString(),
    kind: 'message',
    text: texts.join('\n\n'),
    details: toolUseIds.length > 0 ? { toolUseIds } : {},
  };
}

/**
 * The entry that closes a transcript. `details` always carries `isError`, and
 * carries `numTurns`, `durationMs` and `totalCostUsd` when the SDK reported
 * them (a run that threw before producing a result has none).
 */
export function resultEntry(summary: RunResultSummary, now: Date): TranscriptEntry {
  const details: Record<string, unknown> = { isError: summary.isError };
  if (summary.numTurns !== undefined) {
    details['numTurns'] = summary.numTurns;
  }
  if (summary.durationMs !== undefined) {
    details['durationMs'] = summary.durationMs;
  }
  if (summary.totalCostUsd !== undefined) {
    details['totalCostUsd'] = summary.totalCostUsd;
  }
  return { timestamp: now.toISOString(), kind: 'result', text: summary.text, details };
}
