<script lang="ts">
  /**
   * App shell for the Phase 1 UI. With no project open it shows the
   * ProjectPicker; once a project is open it shows a header (project name +
   * close) and a tabbed dashboard over the three observability views: Agents,
   * Memory, and Audit. View switching is local component state — no router
   * needed for four Phase 1 views.
   */
  import ProjectPicker from "$lib/components/ProjectPicker.svelte";
  import AgentDashboard from "$lib/components/AgentDashboard.svelte";
  import MemoryInspector from "$lib/components/MemoryInspector.svelte";
  import AuditViewer from "$lib/components/AuditViewer.svelte";
  import { projectStore } from "$lib/stores/project.svelte";

  type Tab = "agents" | "memory" | "audit";

  const TABS: { id: Tab; label: string }[] = [
    { id: "agents", label: "Agents" },
    { id: "memory", label: "Memory" },
    { id: "audit", label: "Audit" },
  ];

  let tab = $state<Tab>("agents");

  const project = $derived(projectStore.active);

  function close() {
    projectStore.close();
    tab = "agents";
  }
</script>

<main>
  {#if !project}
    <header class="top">
      <h1>Saor</h1>
    </header>
    <ProjectPicker />
  {:else}
    <header class="top project-top">
      <div class="project-id">
        <h1>{project.name}</h1>
        <span class="muted small">{project.path}</span>
      </div>
      <button type="button" class="secondary" onclick={close}>Close project</button>
    </header>

    <div class="tabs" role="tablist">
      {#each TABS as t (t.id)}
        <button
          type="button"
          role="tab"
          aria-selected={tab === t.id}
          class:active={tab === t.id}
          onclick={() => (tab = t.id)}
        >
          {t.label}
        </button>
      {/each}
    </div>

    <section class="view">
      {#if tab === "agents"}
        <AgentDashboard />
      {:else if tab === "memory"}
        <MemoryInspector />
      {:else}
        <AuditViewer />
      {/if}
    </section>
  {/if}
</main>

<style>
  main {
    max-width: 960px;
    margin: 0 auto;
    padding: 1.5rem;
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
  }
  .top {
    display: flex;
    align-items: center;
  }
  .project-top {
    justify-content: space-between;
    gap: 1rem;
  }
  h1 {
    font-size: 1.5rem;
    margin: 0;
  }
  .project-id {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }
  .tabs {
    display: flex;
    gap: 0.4rem;
    border-bottom: 1px solid var(--border);
    padding-bottom: 0.5rem;
  }
  .tabs button.active {
    border-color: var(--accent);
    background: var(--surface);
    font-weight: 600;
  }
</style>
