/**
 * agents/src/sidecar.ts
 *
 * The agent-layer process entrypoint. The Rust `AgentProcessManager` launches
 * this script with `node dist/sidecar.js --session … --project … --task …`
 * (see src-tauri/src/process/spawner.rs) and manages its lifecycle: it is the
 * process that `agent_start` spawns and `agent_stop` kills.
 *
 * It runs the real Code Agent. The agent's memory, audit, and reference ports
 * are backed by the Rust-owned stores through the storage bridge — line-
 * delimited JSON over this process's own stdin/stdout (ADR-009). Because
 * stdout is that protocol channel, nothing here or below may `console.log`;
 * diagnostics go to stderr.
 *
 * This file is only the process glue (real streams, signals, exit code). The
 * run itself is `runSidecar` in sidecar-runner.ts, which is where the tests
 * are.
 */

import { runCodeAgent } from './definitions/code-agent.js';
import { EXIT_FAILED, parseSidecarArgs, runSidecar } from './sidecar-runner.js';

/** Conventional exit code for death by signal: 128 + the signal number. */
const SIGNAL_EXIT_BASE = 128;
const SIGNAL_NUMBERS = { SIGINT: 2, SIGTERM: 15 } as const;

/**
 * Report `stopped` and exit when asked to terminate. The exit code is non-zero
 * so that a termination Rust did not itself request reads as a failed run, not
 * a completed one. (A stop from the process manager is a hard kill, which this
 * handler never sees; Rust has already marked that session stopped.)
 */
function exitOnSignal(signal: keyof typeof SIGNAL_NUMBERS, argv: readonly string[]): void {
  process.on(signal, () => {
    const args = parseSidecarArgs(argv);
    const line = JSON.stringify({ kind: 'status', status: 'stopped', session: args.session });
    process.stdout.write(`${line}\n`, () => {
      process.exit(SIGNAL_EXIT_BASE + SIGNAL_NUMBERS[signal]);
    });
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  exitOnSignal('SIGTERM', argv);
  exitOnSignal('SIGINT', argv);

  let exitCode: number;
  try {
    exitCode = await runSidecar({
      argv,
      input: process.stdin,
      output: process.stdout,
      runAgent: runCodeAgent,
    });
  } catch (error) {
    // runSidecar reports its own failures; reaching here means it could not
    // even do that.
    console.error('sidecar: unexpected failure', error);
    exitCode = EXIT_FAILED;
  }

  // Exit explicitly, but only once stdout has flushed the final status line.
  process.stdout.write('', () => {
    process.exit(exitCode);
  });
}

void main();
