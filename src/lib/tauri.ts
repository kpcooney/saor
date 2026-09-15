/**
 * src/lib/tauri.ts
 *
 * Typed wrappers around Tauri's invoke() IPC calls. Rather than scattering
 * raw invoke() calls across components, all backend communication is
 * centralized here with typed request/response interfaces. This makes the
 * IPC boundary explicit and keeps components free of backend coupling.
 *
 * Each function corresponds to a Tauri command handler defined in
 * src-tauri/src/lib.rs. If a command is added to the Rust side, a
 * corresponding typed wrapper should be added here.
 *
 * Argument keys use camelCase: Tauri v2 converts camelCase JS arguments to the
 * snake_case Rust parameter names automatically, so `projectId` here maps to
 * `project_id` in the command signature.
 */

import { invoke } from "@tauri-apps/api/core";

import type {
  AgentStatus,
  AuditEvent,
  MemoryCategory,
  MemoryEntry,
  Project,
} from "./types";

// --- Projects ---------------------------------------------------------------

/** Creates a project rooted at `path` and returns the registered record. */
export function createProject(
  name: string,
  path: string,
  description?: string,
): Promise<Project> {
  return invoke("create_project", { name, path, description });
}

/** Fetches a single project by id. */
export function getProject(id: string): Promise<Project> {
  return invoke("get_project", { id });
}

/** Lists all registered projects, newest first. */
export function listProjects(): Promise<Project[]> {
  return invoke("list_projects");
}

// --- Memory -----------------------------------------------------------------

/** Writes a memory entry and returns its generated id. */
export function memoryWrite(
  projectId: string,
  category: MemoryCategory,
  content: string,
  metadata?: unknown,
): Promise<string> {
  return invoke("memory_write", { projectId, category, content, metadata });
}

/** Keyword-searches a project's memory, most relevant first. */
export function memorySearch(
  projectId: string,
  query: string,
  limit?: number,
): Promise<MemoryEntry[]> {
  return invoke("memory_search", { projectId, query, limit });
}

/** Reads a single memory entry by id. */
export function memoryRead(
  projectId: string,
  entryId: string,
): Promise<MemoryEntry> {
  return invoke("memory_read", { projectId, entryId });
}

// --- Audit ------------------------------------------------------------------

/** Returns the most recent audit events for a project (newest first). */
export function auditGetRecent(
  projectId: string,
  limit?: number,
): Promise<AuditEvent[]> {
  return invoke("audit_get_recent", { projectId, limit });
}

/** Returns all audit events from a single session. */
export function auditGetBySession(
  projectId: string,
  sessionId: string,
): Promise<AuditEvent[]> {
  return invoke("audit_get_by_session", { projectId, sessionId });
}

/** Returns all audit events from a single agent. */
export function auditGetByAgent(
  projectId: string,
  agentId: string,
): Promise<AuditEvent[]> {
  return invoke("audit_get_by_agent", { projectId, agentId });
}

// --- Agents -----------------------------------------------------------------

/** Starts an agent for a project and returns its session id. */
export function agentStart(
  projectId: string,
  agentType: string,
  task: string,
): Promise<string> {
  return invoke("agent_start", { projectId, agentType, task });
}

/** Returns the current status of a tracked agent session. */
export function agentStatus(sessionId: string): Promise<AgentStatus> {
  return invoke("agent_status", { sessionId });
}

/** Stops a running agent and returns its final status. */
export function agentStop(sessionId: string): Promise<AgentStatus> {
  return invoke("agent_stop", { sessionId });
}
