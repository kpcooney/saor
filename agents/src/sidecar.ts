/**
 * agents/src/sidecar.ts
 *
 * The agent-layer process entrypoint. The Rust `AgentProcessManager` launches
 * this script with `node dist/sidecar.js --session … --project … --task …`
 * (see src-tauri/src/process/spawner.rs), and manages its lifecycle: it is the
 * process that `agent_start` spawns and `agent_stop` kills.
 *
 * Phase 1 scope: this is a minimal, dependency-light runner. It parses its
 * launch arguments, announces itself on stdout as a JSON line (which the Rust
 * side currently drains), heartbeats so the manager has a live process to
 * track, and shuts down cleanly on SIGTERM.
 *
 * It does NOT yet run the real Code Agent against Rust-owned memory/audit: a
 * Node subprocess cannot call Tauri `invoke`, so the agent's memory/audit/
 * reference ports need a dedicated Node↔Rust storage bridge. Wiring
 * `runCodeAgent` (agents/src/definitions/code-agent.ts) in behind that bridge
 * is a tracked follow-up. Until then this entrypoint proves the spawn → track
 * → stop lifecycle end to end.
 */

/** The launch arguments passed by the Rust spawner. */
interface SidecarArgs {
  session: string;
  project: string;
  projectPath: string;
  agentType: string;
  task: string;
}

/** How often (ms) the sidecar emits a heartbeat line while running. */
const HEARTBEAT_INTERVAL_MS = 5000;

/**
 * Parse `--flag value` pairs from argv into the known launch arguments.
 * Unknown flags are ignored; missing ones default to an empty string so the
 * process still starts (the Rust side always supplies the full set).
 */
function parseArgs(argv: readonly string[]): SidecarArgs {
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

/** Emit a single JSON status line to stdout. */
function emit(status: string, args: SidecarArgs, extra: Record<string, unknown> = {}): void {
  const line = JSON.stringify({
    status,
    session: args.session,
    project: args.project,
    agentType: args.agentType,
    ...extra,
  });
  // eslint-disable-next-line no-console -- stdout is the sidecar's status channel
  console.log(line);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  emit('started', args, { pid: process.pid, task: args.task });

  const heartbeat = setInterval(() => emit('heartbeat', args), HEARTBEAT_INTERVAL_MS);
  // Don't let the heartbeat timer keep the event loop alive on its own.
  heartbeat.unref();

  const shutdown = (): void => {
    clearInterval(heartbeat);
    emit('stopped', args);
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main();
