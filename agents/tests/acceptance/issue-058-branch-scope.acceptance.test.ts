/**
 * agents/tests/acceptance/issue-058-branch-scope.acceptance.test.ts
 *
 * Acceptance: issue #58 — branch scope enforcement (ADR-011).
 *
 * Definition of done: an agent may change files only while a branch inside its
 * `scope.branches` is checked out. The branch is whatever the repository has
 * checked out — read from the repository's files at every call — so switching
 * branches under a running agent takes effect on its next tool call.
 *
 * Real stores: a temp project with a real git repository whose HEAD the test
 * moves, and a real JSONL audit file read back from disk. Every denial is
 * bracketed by the same call being allowed on the scoped branch, so a hook that
 * ignores the branch, or one that blocks every write, cannot pass.
 */

import { writeFileSync } from 'node:fs';

import type { HookJSONOutput, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createScopeEnforcementHook } from '../../src/hooks/scope-enforcement.js';
import { createAgentIdentity } from '../../src/identity/factory.js';
import type { AgentIdentity } from '../../src/identity/types.js';
import { createTempProject, type TempProject } from './support/temp-project.js';

const SCOPED_BRANCH = '58/branch-scope';
const HOOK_OPTIONS = { signal: new AbortController().signal };

/** An identity scoped to every branch of issue 58, and to no other. */
const identity: AgentIdentity = createAgentIdentity({
  id: 'agent:code-agent:acceptance-58',
  type: 'specialist',
  role: 'code-agent',
  delegatedBy: 'human:kevin',
  purpose: 'Implement #58',
  scope: {
    issues: ['58'],
    files: ['src/**'],
    branches: ['58/*'],
    tools: ['Read', 'Write'],
    memoryNamespaces: { read: [], write: [] },
  },
});

describe('#58 branch scope enforcement', () => {
  let project: TempProject;

  beforeEach(() => {
    project = createTempProject(SCOPED_BRANCH);
  });

  afterEach(() => {
    project?.remove();
  });

  /** Run one tool call through the scope hook and return its decision. */
  async function attempt(toolName: string): Promise<string | undefined> {
    const hook = createScopeEnforcementHook({
      identity,
      auditLogger: project.auditLogger,
      projectId: 'proj-acceptance',
    });
    const input: PreToolUseHookInput = {
      hook_event_name: 'PreToolUse',
      session_id: 'session-acceptance-58',
      transcript_path: project.pathOf('transcript.jsonl'),
      cwd: project.root,
      tool_name: toolName,
      tool_input: { file_path: project.pathOf('src/a.ts') },
      tool_use_id: 'tool-use-1',
    };
    const output: HookJSONOutput = await hook(input, 'tool-use-1', HOOK_OPTIONS);
    // The scope hook only returns the PreToolUse shape of the output union.
    return (output as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput
      ?.permissionDecision;
  }

  it('denies an in-scope write while another branch is checked out; allows it again on the scoped branch', async () => {
    expect(await attempt('Write')).toBe('allow');

    project.checkOut('main');
    expect(await attempt('Write')).toBe('deny');
    const events = project.readAudit();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: 'scope.violation',
      result: 'blocked',
      reason: 'Current branch not in agent scope',
    });
    expect(events[0]!.details.branch).toBe('main');

    project.checkOut(SCOPED_BRANCH);
    expect(await attempt('Write')).toBe('allow');
    expect(project.readAudit()).toHaveLength(1);
  });

  it('matches branches by glob: another branch of the issue is in scope, a look-alike is not', async () => {
    project.checkOut('58/second-attempt');
    expect(await attempt('Write')).toBe('allow');

    project.checkOut('580/unrelated');
    expect(await attempt('Write')).toBe('deny');
    project.checkOut('58');
    expect(await attempt('Write')).toBe('deny');

    expect(project.readAudit().map((e) => e.details.branch)).toEqual(['580/unrelated', '58']);
  });

  it('denies writes on a detached HEAD, where there is no branch to be in scope', async () => {
    writeFileSync(project.pathOf('.git/HEAD'), `${'a'.repeat(40)}\n`);
    expect(await attempt('Write')).toBe('deny');
    expect(project.readAudit().map((e) => e.eventType)).toEqual(['scope.violation']);

    // Negative control: back on the scoped branch the same write is allowed.
    project.checkOut(SCOPED_BRANCH);
    expect(await attempt('Write')).toBe('allow');
  });

  it('does not apply to reads: an out-of-scope branch blocks changes, not looking', async () => {
    project.checkOut('main');

    expect(await attempt('Read')).toBe('allow');
    expect(project.readAudit()).toEqual([]);
    // Control: on the same branch the write is still denied.
    expect(await attempt('Write')).toBe('deny');
  });
});
