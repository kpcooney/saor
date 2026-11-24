/**
 * agents/tests/transcript/entries.test.ts
 *
 * Tests for how SDK messages become session-transcript entries (issue #78):
 * what the agent says is kept as text, its tool calls are kept as ids only,
 * and anything that is not the agent speaking is left out.
 */

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { messageEntryFrom, resultEntry, taskEntry } from '../../src/transcript/entries.js';

const NOW = new Date('2026-11-24T02:39:40.000Z');

/** An SDK message with only the fields the transcript reads, hence the cast. */
function sdkMessage(fields: Record<string, unknown>): SDKMessage {
  return { session_id: 'sdk-session-abc', ...fields } as unknown as SDKMessage;
}

function assistant(content: unknown): SDKMessage {
  return sdkMessage({ type: 'assistant', parent_tool_use_id: null, message: { content } });
}

describe('messageEntryFrom', () => {
  it('keeps what the agent said and the ids of the tools it called', () => {
    const entry = messageEntryFrom(
      assistant([
        { type: 'text', text: '  I will check the layout.  ' },
        { type: 'tool_use', id: 'tu-1', name: 'Bash', input: { command: 'ls' } },
        { type: 'text', text: 'Then write the page.' },
        { type: 'tool_use', id: 'tu-2', name: 'Write', input: { file_path: 'src/a.html' } },
      ]),
      NOW,
    );

    expect(entry).toEqual({
      timestamp: '2026-11-24T02:39:40.000Z',
      kind: 'message',
      text: 'I will check the layout.\n\nThen write the page.',
      details: { toolUseIds: ['tu-1', 'tu-2'] },
    });
    // The call itself stays in the audit trail: no tool name or input here.
    expect(JSON.stringify(entry)).not.toContain('file_path');
  });

  it('records a turn that was only tool calls with empty text', () => {
    const entry = messageEntryFrom(assistant([{ type: 'tool_use', id: 'tu-1', name: 'Read' }]), NOW);

    expect(entry).toMatchObject({ text: '', details: { toolUseIds: ['tu-1'] } });
  });

  it('records a turn that was only text with no tool ids', () => {
    const entry = messageEntryFrom(assistant([{ type: 'text', text: 'Done.' }]), NOW);

    expect(entry).toMatchObject({ text: 'Done.', details: {} });
  });

  it('yields nothing for a turn with neither text nor tool calls', () => {
    expect(messageEntryFrom(assistant([{ type: 'thinking', thinking: 'hmm' }]), NOW)).toBeUndefined();
    expect(messageEntryFrom(assistant([{ type: 'text', text: '   ' }]), NOW)).toBeUndefined();
    expect(messageEntryFrom(assistant([]), NOW)).toBeUndefined();
  });

  it('skips content it does not recognise instead of throwing', () => {
    expect(messageEntryFrom(assistant('a bare string'), NOW)).toBeUndefined();
    const entry = messageEntryFrom(
      assistant([null, 'text', { type: 'tool_use' }, { type: 'text', text: 'Still here.' }]),
      NOW,
    );
    expect(entry).toMatchObject({ text: 'Still here.', details: {} });
  });

  it('yields nothing for messages that are not the agent speaking', () => {
    const others = [
      sdkMessage({ type: 'user', message: { content: [{ type: 'text', text: 'tool output' }] } }),
      sdkMessage({ type: 'system', subtype: 'init' }),
      sdkMessage({ type: 'result', subtype: 'success', result: 'ok' }),
    ];

    expect(others.map((message) => messageEntryFrom(message, NOW))).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });
});

describe('taskEntry and resultEntry', () => {
  it('opens a transcript with the launch task', () => {
    expect(taskEntry('Add a README', NOW)).toEqual({
      timestamp: '2026-11-24T02:39:40.000Z',
      kind: 'task',
      text: 'Add a README',
      details: {},
    });
  });

  it('closes a transcript with the outcome and the accounting the SDK gave', () => {
    const entry = resultEntry(
      { text: 'Created README.md.', isError: false, numTurns: 3, durationMs: 24000, totalCostUsd: 0 },
      NOW,
    );

    expect(entry).toEqual({
      timestamp: '2026-11-24T02:39:40.000Z',
      kind: 'result',
      text: 'Created README.md.',
      // A zero cost is a reported value, not a missing one.
      details: { isError: false, numTurns: 3, durationMs: 24000, totalCostUsd: 0 },
    });
  });

  it('leaves out accounting a failed start never had', () => {
    const entry = resultEntry({ text: 'could not start', isError: true }, NOW);

    expect(entry.details).toEqual({ isError: true });
  });
});
