<script lang="ts">
  /**
   * AuditViewer — lists the active project's most recent audit events with a
   * client-side filter. Fetches once (and on manual refresh) via
   * `audit_get_recent`; the "scope violations" and "tool calls" filters narrow
   * the already-loaded list by event type.
   */
  import { auditGetRecent } from "$lib/tauri";
  import { formatTimestamp } from "$lib/format";
  import { projectStore } from "$lib/stores/project.svelte";
  import type { AuditEvent } from "$lib/types";

  type Filter = "all" | "violations" | "tools";

  let events = $state<AuditEvent[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let filter = $state<Filter>("all");

  const project = $derived(projectStore.active);

  const visible = $derived(
    events.filter((e) => {
      if (filter === "violations") return e.eventType === "scope.violation";
      if (filter === "tools") return e.eventType.startsWith("tool.");
      return true;
    }),
  );

  async function load() {
    if (!project) return;
    loading = true;
    error = null;
    try {
      events = await auditGetRecent(project.id);
    } catch (e) {
      error = String(e);
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    load();
  });
</script>

<div class="audit">
  <div class="controls">
    <div class="filters" role="group" aria-label="Filter audit events">
      <button type="button" class:active={filter === "all"} onclick={() => (filter = "all")}>
        All
      </button>
      <button
        type="button"
        class:active={filter === "violations"}
        onclick={() => (filter = "violations")}
      >
        Scope violations
      </button>
      <button type="button" class:active={filter === "tools"} onclick={() => (filter = "tools")}>
        Tool calls
      </button>
    </div>
    <button type="button" class="secondary" onclick={load}>Refresh</button>
  </div>

  {#if error}
    <p class="error">Failed to load audit events. {error}</p>
    <button type="button" onclick={load}>Retry</button>
  {:else if loading}
    <p class="muted">Loading audit events…</p>
  {:else if events.length === 0}
    <p class="muted">No audit events yet.</p>
  {:else if visible.length === 0}
    <p class="muted">No events match this filter.</p>
  {:else}
    <ul class="events">
      {#each visible as event (event.id)}
        <li class="event">
          <div class="event-head">
            <span class="type type-{event.result}">{event.eventType}</span>
            <span class="role">{event.agentRole}</span>
            <span class="muted small">{formatTimestamp(event.timestamp)}</span>
          </div>
          <p class="action">{event.action}</p>
          {#if event.reason}
            <p class="muted small">Reason: {event.reason}</p>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .audit {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
  .controls {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 1rem;
    flex-wrap: wrap;
  }
  .filters {
    display: flex;
    gap: 0.4rem;
  }
  .filters button {
    padding: 0.35rem 0.75rem;
    font-size: 0.85rem;
  }
  .filters button.active {
    border-color: #396cd8;
    background: #eef3ff;
  }
  .events {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .event {
    padding: 0.7rem 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .event-head {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    flex-wrap: wrap;
  }
  .type {
    font-family: ui-monospace, monospace;
    font-size: 0.78rem;
    padding: 0.1rem 0.45rem;
    border-radius: 4px;
    background: #eee;
  }
  .type-blocked,
  .type-failure {
    background: #fde0e0;
    color: #a01c1c;
  }
  .role {
    font-weight: 600;
    font-size: 0.85rem;
  }
  .action {
    margin: 0;
  }
</style>
