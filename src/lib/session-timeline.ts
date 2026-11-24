/**
 * src/lib/session-timeline.ts
 *
 * Turns the two records of an agent session into what the session view shows
 * (issue #78): the transcript (what the agent said — ADR-013) and the session's
 * audit events (what it did). Pure functions, no IPC, so the view component is
 * only fetching and rendering.
 *
 * The join: a transcript message lists the ids of the tool calls the agent made
 * in that turn (`details.toolUseIds`); the audit trail has a `tool.invoked` /
 * `tool.completed` pair per call carrying the same id (`details.toolUseId`).
 * Each call becomes one row, placed after the message that made it.
 *
 * Audit events the transcript does not account for still appear, slotted in by
 * time. That covers a session recorded before transcripts existed, and a
 * transcript with a gap (a write that failed is dropped, not fatal).
 */

import type { AuditEvent, TranscriptEntry } from "$lib/types";

/** How a tool call ended, as far as the audit trail shows. */
export type ToolOutcome =
  /** Invoked, no completion yet, and the session is still running. */
  | "running"
  | "completed"
  | "failed"
  /** Refused by the scope hook, or stopped by the sandbox. */
  | "blocked"
  /** Invoked but never completed, in a session that has ended. */
  | "unfinished";

/** Something the agent said. */
export interface MessageItem {
  type: "message";
  key: string;
  timestamp: string;
  text: string;
}

/** One tool call, with its outcome. */
export interface ToolItem {
  type: "tool";
  key: string;
  timestamp: string;
  /** Display name: an MCP tool's `mcp__server__` prefix is dropped. */
  tool: string;
  /** The one argument worth showing: a command, path, URI or pattern. */
  summary: string;
  outcome: ToolOutcome;
  /** Why it failed or was blocked. */
  reason?: string;
}

/** A blocked or failed event that could not be tied to a tool call. */
export interface NoticeItem {
  type: "notice";
  key: string;
  timestamp: string;
  text: string;
  reason?: string;
}

export type TimelineItem = MessageItem | ToolItem | NoticeItem;

/** How the run ended, from the transcript's closing entry. */
export interface SessionOutcome {
  /** The agent's final answer, or the error. */
  text: string;
  isError: boolean;
  numTurns?: number;
  durationMs?: number;
  totalCostUsd?: number;
}

export interface SessionTimeline {
  items: TimelineItem[];
  /** Absent while the run is in progress, or for a session with no transcript. */
  outcome?: SessionOutcome;
  /** Files written or edited successfully, relative to the project root. */
  changedFiles: string[];
  /** The reason on the session's `agent.failed` event, if there is one. */
  failureReason?: string;
}

export interface TimelineOptions {
  /** The project root, used to show file paths relative to it. */
  projectPath: string;
  /** Whether the session is still running. */
  isActive: boolean;
}

/** Tools whose successful call changes a file named by `file_path`. */
const FILE_CHANGING_TOOLS = ["Write", "Edit", "NotebookEdit"];

/**
 * A `tool.blocked` event carries the tool name but not the call's id, so it is
 * matched to the unresolved call of the same tool logged within this window.
 */
const BLOCK_MATCH_WINDOW_MS = 2000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function detailsOf(source: { details: unknown }): Record<string, unknown> {
  return isRecord(source.details) ? source.details : {};
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" ? value : undefined;
}

/** Milliseconds since the epoch, or 0 for a timestamp that does not parse. */
function timeOf(timestamp: string): number {
  const time = Date.parse(timestamp);
  return Number.isNaN(time) ? 0 : time;
}

/** `mcp__project-memory__memory_read` → `memory_read`; other names unchanged. */
export function displayToolName(tool: string): string {
  const parts = tool.split("__");
  return parts[0] === "mcp" && parts.length >= 3 ? parts.slice(2).join("__") : tool;
}

/** A path under the project root, shown relative to it; any other path as is. */
export function relativeToProject(path: string, projectPath: string): string {
  const root = projectPath.endsWith("/") ? projectPath : `${projectPath}/`;
  return path.startsWith(root) ? path.slice(root.length) : path;
}

/** The argument that best says what a tool call was for. */
function summarize(parameters: Record<string, unknown>, projectPath: string): string {
  const path = stringField(parameters, "file_path") ?? stringField(parameters, "path");
  if (path !== undefined) return relativeToProject(path, projectPath);
  for (const key of ["command", "uri", "pattern", "query"]) {
    const value = stringField(parameters, key);
    if (value !== undefined) return value;
  }
  return "";
}

/** A tool call being assembled from its audit events. */
interface ToolCall {
  item: ToolItem;
  rawTool: string;
  filePath?: string;
}

/** The tool calls of a session, by tool-use id, in the order first seen. */
function collectToolCalls(events: AuditEvent[], projectPath: string): Map<string, ToolCall> {
  const calls = new Map<string, ToolCall>();
  for (const event of events) {
    if (event.eventType !== "tool.invoked" && event.eventType !== "tool.completed") continue;
    const details = detailsOf(event);
    const id = stringField(details, "toolUseId");
    if (id === undefined) continue;

    let call = calls.get(id);
    if (call === undefined) {
      const rawTool = stringField(details, "tool") ?? event.action;
      const parameters = isRecord(details["parameters"]) ? details["parameters"] : {};
      const filePath = stringField(parameters, "file_path");
      call = {
        rawTool,
        ...(filePath !== undefined ? { filePath } : {}),
        item: {
          type: "tool",
          key: `tool:${id}`,
          timestamp: event.timestamp,
          tool: displayToolName(rawTool),
          summary: summarize(parameters, projectPath),
          outcome: "running",
        },
      };
      calls.set(id, call);
    }
    if (event.eventType === "tool.completed") {
      call.item.outcome = event.result === "success" ? "completed" : "failed";
      if (event.result !== "success" && event.reason) call.item.reason = event.reason;
    }
  }
  return calls;
}

/**
 * Applies the session's blocks to its tool calls, and returns a notice for
 * each block that matches no call.
 *
 * A sandbox `scope.violation` names its call by id. A scope-hook
 * `tool.blocked` names only the tool, so it is matched to the still-unresolved
 * call of that tool nearest in time.
 */
function applyBlocks(events: AuditEvent[], calls: Map<string, ToolCall>): NoticeItem[] {
  const notices: NoticeItem[] = [];
  for (const event of events) {
    if (event.eventType !== "tool.blocked" && event.eventType !== "scope.violation") continue;
    const details = detailsOf(event);

    const id = stringField(details, "toolUseId");
    let call = id !== undefined ? calls.get(id) : undefined;
    if (call === undefined) {
      const tool = stringField(details, "tool");
      const at = timeOf(event.timestamp);
      call = [...calls.values()].find(
        (candidate) =>
          candidate.rawTool === tool &&
          candidate.item.outcome === "running" &&
          Math.abs(timeOf(candidate.item.timestamp) - at) <= BLOCK_MATCH_WINDOW_MS,
      );
    }

    if (call !== undefined) {
      call.item.outcome = "blocked";
      if (event.reason) call.item.reason = event.reason;
    } else {
      notices.push({
        type: "notice",
        key: `notice:${event.id}`,
        timestamp: event.timestamp,
        text: event.action,
        ...(event.reason ? { reason: event.reason } : {}),
      });
    }
  }
  return notices;
}

/** A run of items that stay together, positioned by one timestamp. */
interface Group {
  time: number;
  items: TimelineItem[];
}

/** The outcome recorded by a transcript's closing `result` entry. */
function outcomeFrom(entry: TranscriptEntry): SessionOutcome {
  const details = detailsOf(entry);
  const numTurns = numberField(details, "numTurns");
  const durationMs = numberField(details, "durationMs");
  const totalCostUsd = numberField(details, "totalCostUsd");
  return {
    text: entry.text,
    isError: details["isError"] === true,
    ...(numTurns !== undefined ? { numTurns } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(totalCostUsd !== undefined ? { totalCostUsd } : {}),
  };
}

/**
 * Builds the session view's content from a session's transcript and audit
 * events. Both are expected oldest first, which is how the backend returns
 * them.
 */
export function buildSessionTimeline(
  transcript: TranscriptEntry[],
  events: AuditEvent[],
  options: TimelineOptions,
): SessionTimeline {
  const calls = collectToolCalls(events, options.projectPath);
  const notices = applyBlocks(events, calls);
  if (!options.isActive) {
    for (const call of calls.values()) {
      if (call.item.outcome === "running") call.item.outcome = "unfinished";
    }
  }

  // Transcript messages, each followed by the tool calls it made.
  const groups: Group[] = [];
  const placed = new Set<string>();
  let outcome: SessionOutcome | undefined;
  transcript.forEach((entry, index) => {
    if (entry.kind === "result") {
      outcome = outcomeFrom(entry);
      return;
    }
    if (entry.kind !== "message") return;

    const items: TimelineItem[] = [];
    if (entry.text.length > 0) {
      items.push({
        type: "message",
        key: `message:${index}`,
        timestamp: entry.timestamp,
        text: entry.text,
      });
    }
    const ids = detailsOf(entry)["toolUseIds"];
    for (const id of Array.isArray(ids) ? ids : []) {
      const call = typeof id === "string" ? calls.get(id) : undefined;
      if (call !== undefined && !placed.has(call.item.key)) {
        placed.add(call.item.key);
        items.push(call.item);
      }
    }
    if (items.length > 0) groups.push({ time: timeOf(entry.timestamp), items });
  });

  // Everything the transcript did not place, each on its own. Appended after
  // the transcript's groups so that the stable sort below puts a message
  // before an unplaced event logged at the same instant.
  for (const call of calls.values()) {
    if (!placed.has(call.item.key)) {
      groups.push({ time: timeOf(call.item.timestamp), items: [call.item] });
    }
  }
  for (const notice of notices) {
    groups.push({ time: timeOf(notice.timestamp), items: [notice] });
  }
  groups.sort((a, b) => a.time - b.time);

  const changedFiles: string[] = [];
  for (const call of calls.values()) {
    if (
      call.item.outcome === "completed" &&
      call.filePath !== undefined &&
      FILE_CHANGING_TOOLS.includes(call.rawTool)
    ) {
      const file = relativeToProject(call.filePath, options.projectPath);
      if (!changedFiles.includes(file)) changedFiles.push(file);
    }
  }

  const failureReason = events.find((event) => event.eventType === "agent.failed")?.reason;

  return {
    items: groups.flatMap((group) => group.items),
    ...(outcome !== undefined ? { outcome } : {}),
    changedFiles,
    ...(failureReason ? { failureReason } : {}),
  };
}
