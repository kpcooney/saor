/**
 * src/lib/format.ts
 *
 * Small presentation helpers shared across the Phase 1 viewers. Kept trivial
 * and dependency-free — formatting only, no backend coupling.
 */

/**
 * Formats an ISO 8601 timestamp for display. Falls back to the raw string if
 * it cannot be parsed, so a malformed value is shown rather than "Invalid Date".
 */
export function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

/** Collapses whitespace and truncates to `max` characters for a one-line preview. */
export function preview(text: string, max = 140): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

/** A run's length for display: `850 ms`, `24 s`, `3 min 5 s`. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

/** A run's cost in US dollars; sub-cent amounts keep enough digits to read. */
export function formatCost(usd: number): string {
  return usd > 0 && usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}
