/**
 * agents/tests/support/in-memory-memory-store.ts
 *
 * A real, working MemoryStore for the Code Agent integration test (#11). It is
 * not a mock — it genuinely stores entries and searches them with real logic,
 * so a memory write followed by a read round-trips through actual store
 * behavior rather than a canned response. This satisfies the acceptance-check
 * intent ("a memory write then read round-trips ... against a real store")
 * without depending on the Rust SQLite store (reached over IPC in issue #12).
 *
 * Search is a case-insensitive token match over an entry's content, which is
 * enough to prove the round-trip; it is intentionally simpler than the Rust
 * FTS5 ranking it stands in for.
 */

import type {
  KeywordSearchOptions,
  MemoryEntry,
  MemoryStore,
  ProjectContext,
} from '../../src/mcp/memory-server.js';

/** How many recent learnings / conventions `getProjectContext` returns. */
const CONTEXT_LIMIT = 10;

export class InMemoryMemoryStore implements MemoryStore {
  private readonly entries: MemoryEntry[] = [];

  async write(entry: MemoryEntry): Promise<void> {
    this.entries.push(entry);
  }

  async keywordSearch(
    query: string,
    options?: KeywordSearchOptions,
  ): Promise<readonly MemoryEntry[]> {
    const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 0);
    const matches = this.entries.filter((entry) => {
      if (options?.category !== undefined && entry.category !== options.category) {
        return false;
      }
      const haystack = entry.content.toLowerCase();
      // An empty query matches everything; otherwise every term must appear.
      return terms.every((term) => haystack.includes(term));
    });
    // Newest first, then apply the caller's limit.
    const ordered = [...matches].reverse();
    return options?.limit !== undefined ? ordered.slice(0, options.limit) : ordered;
  }

  async getProjectContext(projectId: string): Promise<ProjectContext> {
    const forProject = this.entries.filter((e) => e.projectId === projectId).reverse();
    return {
      projectId,
      recentLearnings: forProject
        .filter((e) => e.category === 'learning')
        .slice(0, CONTEXT_LIMIT),
      conventions: forProject
        .filter((e) => e.category === 'convention')
        .slice(0, CONTEXT_LIMIT),
    };
  }
}
