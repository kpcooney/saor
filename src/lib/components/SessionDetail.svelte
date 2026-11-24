<script lang="ts">
  /**
   * SessionDetail — what one agent session did (issue #78): its outcome, the
   * files it changed, and a timeline of what the agent said interleaved with
   * its tool calls. Shown inside a session's card on the Agents tab.
   *
   * It reads two records: the session transcript (`agent_transcript`, what the
   * agent said) and the session's audit events (`audit_get_by_session`, what
   * it did). `buildSessionTimeline` joins them; this component only fetches
   * and renders. While the session is active it re-reads both on an interval,
   * so the view follows a run in progress.
   */
  import { agentTranscript, auditGetBySession } from "$lib/tauri";
  import { formatCost, formatDuration } from "$lib/format";
  import { buildSessionTimeline, type ToolOutcome } from "$lib/session-timeline";
  import type { AgentSession, AuditEvent, TranscriptEntry } from "$lib/types";

  interface Props {
    session: AgentSession;
    /** The project root, used to show file paths relative to it. */
    projectPath: string;
  }

  let { session, projectPath }: Props = $props();

  /** How often to re-read a running session's records. */
  const POLL_MS = 2000;

  const OUTCOME_LABELS: Record<ToolOutcome, string> = {
    running: "running",
    completed: "ok",
    failed: "failed",
    blocked: "blocked",
    unfinished: "did not finish",
  };

  let transcript = $state<TranscriptEntry[]>([]);
  let events = $state<AuditEvent[]>([]);
  let loaded = $state(false);
  let error = $state<string | null>(null);

  const timeline = $derived(
    buildSessionTimeline(transcript, events, {
      projectPath,
      isActive: session.status === "active",
    }),
  );
  const outcome = $derived(timeline.outcome);

  /** Turns, duration and cost, for whichever of them the run reported. */
  const accounting = $derived.by(() => {
    if (!outcome) return "";
    const parts: string[] = [];
    if (outcome.numTurns !== undefined) parts.push(`${outcome.numTurns} turns`);
    if (outcome.durationMs !== undefined) parts.push(formatDuration(outcome.durationMs));
    if (outcome.totalCostUsd !== undefined) parts.push(formatCost(outcome.totalCostUsd));
    return parts.join(" · ");
  });

  // Load on mount, again whenever the session's status changes (so the final
  // records are read once the run ends), and on an interval while it is
  // active. Cycles are self-scheduled, so a slow read cannot overlap the next.
  $effect(() => {
    const { sessionId, projectId, status } = session;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function load() {
      try {
        const [nextTranscript, nextEvents] = await Promise.all([
          agentTranscript(projectId, sessionId),
          auditGetBySession(projectId, sessionId),
        ]);
        if (cancelled) return;
        transcript = nextTranscript;
        events = nextEvents;
        error = null;
      } catch (e) {
        if (cancelled) return;
        error = String(e);
      } finally {
        if (!cancelled) {
          loaded = true;
          if (status === "active") timer = setTimeout(load, POLL_MS);
        }
      }
    }

    load();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  });
</script>

<div class="detail">
  {#if error}
    <p class="error">Failed to load this session. {error}</p>
  {/if}

  {#if outcome}
    <section class="outcome" class:outcome-error={outcome.isError}>
      <h3>{outcome.isError ? "Ended with an error" : "Result"}</h3>
      <p class="text">{outcome.text}</p>
      {#if accounting}
        <p class="muted small">{accounting}</p>
      {/if}
    </section>
  {:else if timeline.failureReason}
    <section class="outcome outcome-error">
      <h3>Failed</h3>
      <p class="text">{timeline.failureReason}</p>
    </section>
  {:else if session.status === "active"}
    <p class="muted">Running…</p>
  {:else if loaded && transcript.length === 0}
    <p class="muted small">
      This session has no transcript, so only its tool calls are shown.
    </p>
  {/if}

  {#if timeline.changedFiles.length > 0}
    <section>
      <h3>Files changed</h3>
      <ul class="files">
        {#each timeline.changedFiles as file (file)}
          <li><code>{file}</code></li>
        {/each}
      </ul>
    </section>
  {/if}

  <section>
    <h3>Timeline</h3>
    {#if !loaded}
      <p class="muted">Loading…</p>
    {:else if timeline.items.length === 0}
      <p class="muted">Nothing recorded yet.</p>
    {:else}
      <ol class="timeline">
        {#each timeline.items as item (item.key)}
          {#if item.type === "message"}
            <li class="message"><p class="text">{item.text}</p></li>
          {:else if item.type === "tool"}
            <li class="tool">
              <div class="tool-head">
                <span class="tool-name">{item.tool}</span>
                <span class="badge badge-{item.outcome}">{OUTCOME_LABELS[item.outcome]}</span>
              </div>
              {#if item.summary}
                <code class="summary">{item.summary}</code>
              {/if}
              {#if item.reason}
                <p class="reason small">{item.reason}</p>
              {/if}
            </li>
          {:else}
            <li class="tool">
              <div class="tool-head">
                <span class="tool-name">{item.text}</span>
                <span class="badge badge-blocked">blocked</span>
              </div>
              {#if item.reason}
                <p class="reason small">{item.reason}</p>
              {/if}
            </li>
          {/if}
        {/each}
      </ol>
    {/if}
  </section>
</div>

<style>
  .detail {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    border-top: 1px solid var(--border);
    padding-top: 0.85rem;
    margin-top: 0.35rem;
  }
  section {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  h3 {
    font-size: 0.8rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    margin: 0;
    color: var(--muted-text);
  }
  p {
    margin: 0;
  }
  /* Agent text keeps its own line breaks. */
  .text {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .outcome {
    border-left: 3px solid var(--accent);
    padding-left: 0.75rem;
  }
  .outcome-error {
    border-left-color: var(--error);
  }
  .files {
    margin: 0;
    padding-left: 1.1rem;
  }
  .timeline {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }
  .tool {
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 0.45rem 0.65rem;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .tool-head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .tool-name {
    font-family: ui-monospace, monospace;
    font-size: 0.85rem;
    font-weight: 600;
  }
  .summary {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .reason {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    color: var(--muted-text);
  }
  /* Badges set both background and text colour: they are light chips in both
     colour schemes, so they must not inherit the scheme's text colour. */
  .badge {
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 0.05rem 0.4rem;
    border-radius: 999px;
    background: #e6e6e6;
    color: #333333;
  }
  .badge-completed {
    background: #dff3e0;
    color: #1c6b2c;
  }
  .badge-running {
    background: #e0ecff;
    color: #1c46a0;
  }
  .badge-failed,
  .badge-blocked {
    background: #fde0e0;
    color: #a01c1c;
  }
</style>
