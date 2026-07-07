<script lang="ts">
  /**
   * ProjectPicker — the entry view when no project is open. Lists existing
   * projects to open, and provides a creation form. On success (create or
   * open) it hands the project to the shared store, which flips the app shell
   * to the dashboard.
   *
   * Path validation note: the backend exposes no "is this path writable?"
   * command, so we validate only what the client can see (name/path present).
   * The authoritative check — path already holds a project, path not writable —
   * is enforced by `create_project`, whose error string we surface inline. A
   * dedicated real-time validation IPC is deferred (Phase 1 scope).
   */
  import { createProject, listProjects } from "$lib/tauri";
  import { formatTimestamp } from "$lib/format";
  import { projectStore } from "$lib/stores/project.svelte";
  import type { Project } from "$lib/types";

  let projects = $state<Project[]>([]);
  let loadError = $state<string | null>(null);
  let loading = $state(true);

  let name = $state("");
  let path = $state("");
  let description = $state("");
  let submitting = $state(false);
  let createError = $state<string | null>(null);

  const canSubmit = $derived(
    name.trim().length > 0 && path.trim().length > 0 && !submitting,
  );

  async function load() {
    loading = true;
    loadError = null;
    try {
      projects = await listProjects();
    } catch (e) {
      loadError = String(e);
    } finally {
      loading = false;
    }
  }

  async function submit(event: Event) {
    event.preventDefault();
    if (!canSubmit) return;
    submitting = true;
    createError = null;
    try {
      const project = await createProject(
        name.trim(),
        path.trim(),
        description.trim() || undefined,
      );
      projectStore.open(project);
    } catch (e) {
      createError = String(e);
    } finally {
      submitting = false;
    }
  }

  $effect(() => {
    load();
  });
</script>

<div class="picker">
  <section class="existing">
    <h2>Open a project</h2>
    {#if loading}
      <p class="muted">Loading projects…</p>
    {:else if loadError}
      <p class="error">Failed to load projects. {loadError}</p>
      <button type="button" onclick={load}>Retry</button>
    {:else if projects.length === 0}
      <p class="muted">No projects yet. Create one to get started.</p>
    {:else}
      <ul class="project-list">
        {#each projects as project (project.id)}
          <li>
            <button type="button" class="project-row" onclick={() => projectStore.open(project)}>
              <span class="project-name">{project.name}</span>
              <span class="project-path">{project.path}</span>
              <span class="muted small">Created {formatTimestamp(project.createdAt)}</span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  <section class="create">
    <h2>Create a project</h2>
    <form onsubmit={submit}>
      <label>
        Name <span class="req">*</span>
        <input bind:value={name} placeholder="My project" required />
      </label>
      <label>
        Path <span class="req">*</span>
        <input bind:value={path} placeholder="/absolute/path/to/project" required />
      </label>
      <label>
        Description
        <input bind:value={description} placeholder="Optional" />
      </label>
      {#if createError}
        <p class="error">{createError}</p>
      {/if}
      <button type="submit" disabled={!canSubmit}>
        {submitting ? "Creating…" : "Create project"}
      </button>
    </form>
  </section>
</div>

<style>
  .picker {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 2rem;
    align-items: start;
  }
  h2 {
    font-size: 1.1rem;
    margin: 0 0 0.75rem;
  }
  .project-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .project-row {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.15rem;
    width: 100%;
    text-align: left;
    padding: 0.75rem;
  }
  .project-name {
    font-weight: 600;
  }
  .project-path {
    font-family: ui-monospace, monospace;
    font-size: 0.85rem;
    opacity: 0.8;
  }
  form {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.9rem;
  }
  .req {
    color: #d33;
  }
  @media (max-width: 720px) {
    .picker {
      grid-template-columns: 1fr;
    }
  }
</style>
