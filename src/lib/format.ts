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
