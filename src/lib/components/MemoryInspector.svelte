<script lang="ts">
  /**
   * MemoryInspector — a debounced keyword search over the active project's
   * memory store. Renders distinct empty and error states as required by the
   * issue's acceptance criteria.
   *
   * The box is a plain keyword field, so its raw text is turned into a safe
   * FTS5 query before it reaches the backend (`toFtsQuery`): each alphanumeric
   * token is quoted and the tokens are AND-ed together. This keeps punctuation
   * and FTS operators a user might type out of FTS5's parser (which would raise
   * a syntax error), and a query with no usable tokens — blank, or all
   * punctuation — short-circuits to the empty state without a backend call (an
   * empty FTS MATCH is itself a syntax error). The lower-level
   * `memory::keyword_search` still accepts raw FTS syntax for callers that want it.
   *
   * Searches are generation-guarded: each run captures a sequence number and
   * applies its result only if it is still the latest, so a slow in-flight
   * search can't overwrite the results of a newer query or a cleared box.
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

  // Monotonic id of the most recent search; a response whose id no longer
  // matches is stale (a newer query started, or the box was cleared) and is
  // discarded rather than applied.
  let latest = 0;

  /**
   * Builds a safe FTS5 MATCH string from free-text input: quote each
   * alphanumeric token and AND them with spaces. Returns "" when there are no
   * usable tokens, which the caller treats as "don't search".
   */
  function toFtsQuery(raw: string): string {
    const tokens = raw.match(/[\p{L}\p{N}_]+/gu);
    return tokens ? tokens.map((t) => `"${t}"`).join(" ") : "";
  }

  async function run(ftsQuery: string, id: number) {
    if (!project) return;
    loading = true;
    error = null;
    try {
      const found = await memorySearch(project.id, ftsQuery);
      if (id !== latest) return;
      results = found;
    } catch (e) {
      if (id !== latest) return;
      error = String(e);
    } finally {
      if (id === latest) loading = false;
    }
  }

  // Debounce searches: re-run `run` a short delay after `query` settles. The
  // effect reads `query` (tracked) so it re-schedules on every keystroke and
  // cancels the pending timer on cleanup. Bumping `latest` on every run also
  // invalidates any in-flight search, so clearing the box (or typing a newer
  // query) can't be overwritten by a late response.
  $effect(() => {
    const id = ++latest;
    const fts = toFtsQuery(query);
    if (!fts) {
      results = [];
      error = null;
      loading = false;
      return;
    }
    const timer = setTimeout(() => run(fts, id), DEBOUNCE_MS);
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
    <button type="button" onclick={() => run(toFtsQuery(query), ++latest)}>Retry</button>
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
