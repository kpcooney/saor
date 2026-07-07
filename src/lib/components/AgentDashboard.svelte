<script lang="ts">
  /**
   * AgentDashboard — start a Code Agent against the active project, watch its
   * status, and stop it. Sessions are held in the shared store (the backend
   * has no session-list command in Phase 1), so this view shows the sessions
   * started during the current UI session and polls each active one's status.
   */
  import { agentStart, agentStatus, agentStop } from "$lib/tauri";
  import { formatTimestamp } from "$lib/format";
  import { projectStore } from "$lib/stores/project.svelte";

  /** The only agent type wired up in Phase 1. */
  const AGENT_TYPE = "code-agent";

  /** How often to refresh the status of active sessions. */
  const POLL_MS = 2000;

  let task = $state("");
  let starting = $state(false);
  let startError = $state<string | null>(null);
  let stopErrors = $state<Record<string, string>>({});

  const project = $derived(projectStore.active);
  const sessions = $derived(projectStore.sessions);
  const hasActive = $derived(sessions.some((s) => s.status === "active"));
  const canStart = $derived(task.trim().length > 0 && !starting);

  async function start(event: Event) {
    event.preventDefault();
    if (!project || !canStart) return;
    starting = true;
    startError = null;
    try {
      const sessionId = await agentStart(project.id, AGENT_TYPE, task.trim());
      projectStore.addSession({
        sessionId,
        projectId: project.id,
        agentType: AGENT_TYPE,
        task: task.trim(),
        status: "active",
        startedAt: new Date().toISOString(),
      });
      task = "";
    } catch (e) {
      startError = String(e);
    } finally {
      starting = false;
    }
  }

  async function stop(sessionId: string) {
    try {
      const status = await agentStop(sessionId);
      projectStore.setSessionStatus(sessionId, status);
      const { [sessionId]: _, ...rest } = stopErrors;
      stopErrors = rest;
    } catch (e) {
      stopErrors = { ...stopErrors, [sessionId]: String(e) };
    }
  }

  // Poll the status of every active session while any are running. The
  // interval is torn down and re-created by the effect when `hasActive` flips.
  $effect(() => {
    if (!hasActive) return;
    const timer = setInterval(async () => {
      for (const session of projectStore.sessions) {
        if (session.status !== "active") continue;
        try {
          const status = await agentStatus(session.sessionId);
          projectStore.setSessionStatus(session.sessionId, status);
        } catch {
          // Transient status-read failure; next tick retries.
        }
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  });
</script>

<div class="dashboard">
  <form onsubmit={start}>
    <label>
      Task for the Code Agent
      <textarea
        bind:value={task}
        rows="3"
        placeholder="Describe what the agent should do…"
      ></textarea>
    </label>
    {#if startError}
      <p class="error">{startError}</p>
    {/if}
    <button type="submit" disabled={!canStart}>
      {starting ? "Starting…" : "Start Agent"}
    </button>
  </form>

  <h2>Sessions</h2>
  {#if sessions.length === 0}
    <p class="muted">No agent sessions started this session.</p>
  {:else}
    <ul class="session-list">
      {#each sessions as session (session.sessionId)}
        <li class="session">
          <div class="session-head">
            <span class="agent-type">{session.agentType}</span>
            <span class="status status-{session.status}">{session.status}</span>
          </div>
          <p class="task">{session.task}</p>
          <p class="muted small">
            Started {formatTimestamp(session.startedAt)} · <code>{session.sessionId}</code>
          </p>
          {#if stopErrors[session.sessionId]}
            <p class="error">{stopErrors[session.sessionId]}</p>
          {/if}
          {#if session.status === "active"}
            <button type="button" class="secondary" onclick={() => stop(session.sessionId)}>
              Stop
            </button>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .dashboard {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }
  form {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    max-width: 640px;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.9rem;
  }
  textarea {
    font-family: inherit;
    resize: vertical;
  }
  h2 {
    font-size: 1.1rem;
    margin: 0;
  }
  .session-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .session {
    padding: 0.85rem 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  .session-head {
    display: flex;
    align-items: center;
    gap: 0.6rem;
  }
  .agent-type {
    font-weight: 600;
    font-family: ui-monospace, monospace;
  }
  .status {
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 0.1rem 0.45rem;
    border-radius: 999px;
  }
  .status-active {
    background: #dff3e0;
    color: #1c6b2c;
  }
  .status-stopped {
    background: #eee;
    color: #555;
  }
  .status-completed {
    background: #e0ecff;
    color: #1c46a0;
  }
  .status-failed {
    background: #fde0e0;
    color: #a01c1c;
  }
  .task {
    margin: 0;
  }
  button.secondary {
    align-self: flex-start;
  }
</style>
