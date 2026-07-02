/**
 * agents/src/index.ts
 *
 * Entry point for the Saor agent layer. This package runs as a standalone
 * Node.js process (Tauri sidecar), not in the browser. It initializes the
 * agent harness, registers MCP servers, and exposes the interface through
 * which the Tauri backend can spawn and communicate with SDLC agents.
 *
 * See docs/architecture/sdlc-agent-architecture-research-v4.md for the
 * full agent architecture.
 */

// Agent identity (issue #7): the structured identity every agent carries and
// the factory that constructs it.
export type {
  AgentCredential,
  AgentIdentity,
  AgentScope,
  AgentType,
  MemoryNamespaceScope,
} from './identity/types.js';
export {
  createAgentIdentity,
  DEFAULT_AGENT_TTL_MS,
} from './identity/factory.js';
export type {
  AgentIdentitySpec,
  CreateAgentIdentityOptions,
} from './identity/factory.js';

// Scope enforcement (issue #7): the PreToolUse hook that keeps an agent within
// its declared scope.
export {
  createScopeEnforcementHook,
  evaluateToolCall,
  buildScopeViolationEvent,
} from './hooks/scope-enforcement.js';
export type {
  ScopeDecision,
  ScopeViolation,
  ScopeEnforcementConfig,
  PreToolUseHookCallback,
} from './hooks/scope-enforcement.js';

// Audit trail contract (defined here in issue #7; the IPC-backed logger and
// the PostToolUse hook land in issue #10).
export type {
  AuditEvent,
  AuditEventType,
  AuditResult,
  AuditLogger,
} from './hooks/audit-logger.js';

// Memory MCP server (issue #8): the in-process MCP tools for reading and
// writing project memory, defined against the MemoryStore port. The concrete
// IPC-backed store adapter lands with the Tauri IPC work (issue #12).
export {
  createMemoryMcpServer,
  memoryRead,
  memoryWrite,
  memoryContext,
  memoryToolContextFromIdentity,
  DEFAULT_MEMORY_READ_LIMIT,
  MAX_MEMORY_READ_LIMIT,
} from './mcp/memory-server.js';
export type {
  MemoryCategory,
  MemoryEntry,
  MemoryStore,
  KeywordSearchOptions,
  ProjectContext,
  MemoryToolContext,
  MemoryReadArgs,
  MemoryWriteArgs,
  MemoryToolDeps,
  MemoryMcpServerConfig,
} from './mcp/memory-server.js';
