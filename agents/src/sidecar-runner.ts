/**
 * agents/src/sidecar-runner.ts
 *
 * Runs one agent session inside the sidecar process: it turns the launch
 * arguments into a Code Agent wired to the Rust-owned stores through the
 * storage bridge (ADR-009), runs it on the launch task, and reports the outcome.
 *
 * This is the logic behind the `sidecar.ts` entrypoint, split out so it can be
 * tested without a live LLM: the streams and the agent runner are injected, so
 * a test drives it over in-memory streams with a scripted runner while
 * production passes `process.stdin` / `process.stdout` and `runCodeAgent`.
 *
 * What the Rust side sees on stdout, in order:
 *
 *   1. a `started` status line
 *   2. bridge requests, as the agent's hooks and MCP tools use the stores
 *   3. a `completed` or `failed` status line
 *
 * and then the process exits with code 0 or 1. Rust records the lifecycle audit
 * events (`agent.created`, then `agent.completed` / `agent.failed`) from what it
 * observes — the spawn, the `failed` status line's error, and the exit code —
 * so this module does not log them itself.
 */

import type { Readable, Writable } from 'node:stream';

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

import {
  createBridgeAuditLogger,
  createBridgeMemoryStore,
  createBridgeReferenceResolver,
} from './bridge/adapters.js';
import { createBridgeClient, type BridgeClient } from './bridge/client.js';
import {
  CODE_AGENT_ROLE,
  createCodeAgentIdentity,
  type CodeAgentRuntimeConfig,
} from './definitions/code-agent.js';

/** The launch arguments passed by the Rust spawner (process/spawner.rs). */
export interface SidecarArgs {
  /** The Saor session id the process manager assigned to this run. */
  readonly session: string;
  /** The project's id in the app registry. */
  readonly project: string;
  /** The project's root directory — the agent's working directory. */
  readonly projectPath: string;
  /** Which agent to run, e.g. "code-agent". */
  readonly agentType: string;
  /** The task prompt the agent is launched with. */
  readonly task: string;
}

/**
 * The human at the head of a locally launched agent's delegation chain. Must
 * match the chain Rust stamps on the lifecycle events it records for the same
 * run (`log_lifecycle_event` in src-tauri/src/commands/agent.rs).
 */
export const LOCAL_HUMAN_DELEGATOR = 'human:local';

/** Process exit code for a run that completed. */
export const EXIT_COMPLETED = 0;
/** Process exit code for a run that failed, including a bad launch. */
export const EXIT_FAILED = 1;

/**
 * Runs an agent on a prompt and yields its SDK message stream. `runCodeAgent`
 * satisfies this; tests substitute a scripted generator.
 */
export type AgentRunner = (
  prompt: string,
  config: CodeAgentRuntimeConfig,
) => AsyncIterable<SDKMessage>;

/** Everything {@link runSidecar} needs from the outside world. */
export interface SidecarDeps {
  /** Launch arguments, without the `node` and script entries. */
  readonly argv: readonly string[];
  /** Where bridge responses arrive (the process's stdin). */
  readonly input: Readable;
  /** Where bridge requests and status lines are written (the process's stdout). */
  readonly output: Writable;
  /** Runs the agent. */
  readonly runAgent: AgentRunner;
}

/** How an agent run ended, as far as the sidecar could tell. */
type RunOutcome =
  | { readonly ok: true; readonly numTurns: number }
  | { readonly ok: false; readonly error: string };

/**
 * Parse `--flag value` pairs from argv into the known launch arguments.
 * Unknown flags are ignored; missing ones become an empty string, which
 * {@link describeInvalidArgs} then rejects.
 */
export function parseSidecarArgs(argv: readonly string[]): SidecarArgs {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token !== undefined && token.startsWith('--')) {
      flags[token.slice(2)] = argv[i + 1] ?? '';
      i += 1;
    }
  }
  return {
    session: flags['session'] ?? '',
    project: flags['project'] ?? '',
    projectPath: flags['project-path'] ?? '',
    agentType: flags['agent-type'] ?? '',
    task: flags['task'] ?? '',
  };
}

/**
 * Explain why the launch arguments cannot start a run, or return `undefined`
 * when they can. The Rust spawner always supplies the full set, so a failure
 * here means the sidecar was launched some other way.
 */
export function describeInvalidArgs(args: SidecarArgs): string | undefined {
  const required: readonly (readonly [string, string])[] = [
    ['--session', args.session],
    ['--project', args.project],
    ['--project-path', args.projectPath],
    ['--task', args.task],
  ];
  const missing = required.filter(([, value]) => value.length === 0).map(([flag]) => flag);
  if (missing.length > 0) {
    return `missing required launch argument(s): ${missing.join(', ')}`;
  }
  if (args.agentType !== CODE_AGENT_ROLE) {
    return `unsupported agent type "${args.agentType}": only "${CODE_AGENT_ROLE}" can be launched`;
  }
  return undefined;
}

/**
 * The identity id for a launched agent: `agent:{type}:{session}`. Rust derives
 * the same id for the lifecycle events it records, so those events and the
 * agent's own tool and memory events share one `agentId`.
 */
export function sidecarAgentId(args: SidecarArgs): string {
  return `agent:${args.agentType}:${args.session}`;
}

/**
 * Build the Code Agent's runtime config for a launch: its identity, and the
 * three storage ports backed by the bridge.
 */
export function buildSidecarRuntimeConfig(
  args: SidecarArgs,
  client: BridgeClient,
): CodeAgentRuntimeConfig {
  const identity = createCodeAgentIdentity({
    id: sidecarAgentId(args),
    delegatedBy: LOCAL_HUMAN_DELEGATOR,
    purpose: args.task,
  });
  return {
    identity,
    projectId: args.project,
    cwd: args.projectPath,
    memoryStore: createBridgeMemoryStore(client),
    referenceResolver: createBridgeReferenceResolver(client),
    auditLogger: createBridgeAuditLogger(client, { sessionId: args.session }),
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Drain the agent's message stream and derive the outcome from its final
 * `result` message. A stream that ends without one is a failure — the run did
 * not finish in a way the SDK reported.
 */
async function awaitOutcome(messages: AsyncIterable<SDKMessage>): Promise<RunOutcome> {
  let outcome: RunOutcome = {
    ok: false,
    error: 'the agent run ended without reporting a result',
  };
  for await (const message of messages) {
    if (message.type !== 'result') {
      continue;
    }
    if (message.subtype === 'success' && !message.is_error) {
      outcome = { ok: true, numTurns: message.num_turns };
    } else if (message.subtype === 'success') {
      outcome = { ok: false, error: message.result };
    } else {
      const detail = message.errors.join('; ');
      outcome = { ok: false, error: detail.length > 0 ? detail : message.subtype };
    }
  }
  return outcome;
}

/**
 * Run one agent session to completion and return the process exit code
 * ({@link EXIT_COMPLETED} or {@link EXIT_FAILED}). Never throws: every failure
 * is reported on a `failed` status line so Rust can record why the run ended.
 */
export async function runSidecar(deps: SidecarDeps): Promise<number> {
  const args = parseSidecarArgs(deps.argv);
  const client = createBridgeClient({ input: deps.input, output: deps.output });
  const identifiers = { session: args.session, project: args.project, agentType: args.agentType };

  try {
    const invalid = describeInvalidArgs(args);
    if (invalid !== undefined) {
      client.sendStatus('failed', { ...identifiers, error: invalid });
      return EXIT_FAILED;
    }

    client.sendStatus('started', { ...identifiers, pid: process.pid });

    let outcome: RunOutcome;
    try {
      outcome = await awaitOutcome(
        deps.runAgent(args.task, buildSidecarRuntimeConfig(args, client)),
      );
    } catch (error) {
      outcome = { ok: false, error: describeError(error) };
    }

    if (outcome.ok) {
      client.sendStatus('completed', { ...identifiers, numTurns: outcome.numTurns });
      return EXIT_COMPLETED;
    }
    client.sendStatus('failed', { ...identifiers, error: outcome.error });
    return EXIT_FAILED;
  } finally {
    client.close();
  }
}
