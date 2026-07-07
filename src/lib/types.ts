/**
 * src/lib/types.ts
 *
 * Shared TypeScript types for the frontend layer. These are the data shapes
 * the UI works with — Project, AgentSession, MemoryEntry, AuditEvent — which
 * mirror the structures returned by Tauri IPC commands from the Rust backend.
 *
 * Keep these types aligned with the Rust structs in src-tauri/src/. They are
 * not generated automatically, so they must be updated manually when the
 * backend types change. In a future phase this could be automated via
 * tauri-specta or a similar codegen tool.
 *
 * IMPORTANT — field casing follows each struct's serde attribute, not a single
 * convention:
 *   - ProjectRecord, AuditEvent, AgentSession use `rename_all = "camelCase"`.
 *   - MemoryEntry has no rename attribute, so its fields stay snake_case.
 * Mirror those exactly, or `invoke()` results will have undefined fields.
 */

/** Mirrors `project::ProjectRecord` (camelCase). */
export interface Project {
  id: string;
  name: string;
  /** Absolute path to the project root (the directory holding `.sdlc/`). */
  path: string;
  /** Free-text description; empty string when none. */
  description: string;
  createdAt: string;
}

/** Mirrors `memory::MemoryCategory` (lowercase serde). */
export type MemoryCategory = "learning" | "convention" | "context" | "index";

/**
 * Mirrors `memory::MemoryEntry`. Note the snake_case fields — MemoryEntry is
 * the one backend struct without a camelCase rename attribute.
 */
export interface MemoryEntry {
  id: string;
  project_id: string;
  category: MemoryCategory;
  content: string;
  metadata: unknown;
  created_by: string;
  created_at: string;
  weight: number;
}

/**
 * Mirrors `audit::AuditEventType`. Serialized as dot-notation strings
 * (e.g. "tool.invoked", "scope.violation").
 */
export type AuditEventType =
  | "agent.created"
  | "agent.completed"
  | "agent.failed"
  | "agent.expired"
  | "tool.invoked"
  | "tool.completed"
  | "tool.blocked"
  | "file.read"
  | "file.write"
  | "file.delete"
  | "issue.created"
  | "issue.updated"
  | "issue.closed"
  | "memory.read"
  | "memory.write"
  | "decision.routing"
  | "decision.approval"
  | "decision.rejection"
  | "handoff.initiated"
  | "handoff.completed"
  | "scope.violation"
  | "credential.expired"
  | "auth.failed";

/** Mirrors `audit::AuditResult` (lowercase serde). */
export type AuditResult = "success" | "failure" | "blocked" | "pending";

/** Mirrors `audit::AuditEvent` (camelCase). */
export interface AuditEvent {
  id: string;
  timestamp: string;
  projectId: string;
  agentId: string;
  agentRole: string;
  delegationChain: string[];
  eventType: AuditEventType;
  action: string;
  details: unknown;
  issueRef?: string;
  initiativeRef?: string;
  sessionId: string;
  result: AuditResult;
  reason?: string;
}

/** Mirrors `process::manager::AgentStatus` (lowercase serde). */
export type AgentStatus = "active" | "completed" | "failed" | "stopped";

/** Mirrors `process::manager::AgentSession` (camelCase). */
export interface AgentSession {
  sessionId: string;
  projectId: string;
  agentType: string;
  task: string;
  status: AgentStatus;
  startedAt: string;
}
