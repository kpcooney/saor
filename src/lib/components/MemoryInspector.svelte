<script lang="ts">
  /**
   * MemoryInspector — a debounced keyword search over the active project's
   * memory store. Renders distinct empty and error states as required by the
   * issue's acceptance criteria.
   *
   * A blank query is never sent to the backend: FTS5 raises a syntax error on
   * an empty MATCH, so a blank box shows the "No memory entries yet." empty
   * state and clears results instead of searching.
   */
  import { memorySearch } from "$lib/tauri";
  import { formatTimestamp, preview } from "$lib/format";
  import { projectStore } from "$lib/stores/project.svelte";
  import type { MemoryEntry } from "$lib/types";

  const DEBOUNCE_MS = 250;

  let query = $state("");
  let results = $state<MemoryEntry[]>([]);
  let loading = $state(false);
  let error = $state<string | null>(null);

  const project = $derived(projectStore.active);

  async function run(q: string) {
    if (!project) return;
    loading = true;
    error = null;
    try {
      results = await memorySearch(project.id, q);
    } catch (e) {
      error = String(e);
    } finally {
      loading = false;
    }
  }

  // Debounce searches: re-run `run` a short delay after `query` settles. The
  // effect reads `query` (tracked) so it re-schedules on every keystroke and
  // cancels the pending timer on cleanup. A blank query short-circuits to the
  // empty state without a backend call (empty FTS MATCH is a syntax error).
  $effect(() => {
    const q = query.trim();
    if (!q) {
      results = [];
      error = null;
      return;
    }
    const timer = setTimeout(() => run(q), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  });
</script>

<div class="memory">
  <input
    class="search"
    bind:value={query}
    placeholder="Search memory…"
    aria-label="Search memory"
  />

  {#if error}
    <p class="error">Failed to load memory. {error}</p>
    <button type="button" onclick={() => run(query)}>Retry</button>
  {:else if loading && results.length === 0}
    <p class="muted">Searching…</p>
  {:else if results.length === 0}
    <p class="muted">
      {query.trim() ? `No results for "${query.trim()}".` : "No memory entries yet."}
    </p>
  {:else}
    <ul class="results">
      {#each results as entry (entry.id)}
        <li class="entry">
          <div class="entry-head">
            <span class="category category-{entry.category}">{entry.category}</span>
            <span class="muted small">{entry.created_by}</span>
            <span class="muted small">{formatTimestamp(entry.created_at)}</span>
          </div>
          <p class="content">{preview(entry.content)}</p>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .memory {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
  .search {
    max-width: 480px;
  }
  .results {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .entry {
    padding: 0.75rem 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  .entry-head {
    display: flex;
    align-items: center;
    gap: 0.6rem;
  }
  .category {
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 0.1rem 0.45rem;
    border-radius: 999px;
    background: #ececff;
    color: #3a3ab0;
  }
  .content {
    margin: 0;
  }
</style>
