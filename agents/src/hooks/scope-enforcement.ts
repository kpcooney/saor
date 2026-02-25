/**
 * agents/src/hooks/scope-enforcement.ts
 *
 * PreToolUse hook that enforces agent scope before every tool invocation.
 * If an agent attempts to write a file outside its allowed glob patterns,
 * invoke a tool not on its allowlist, or act after its credential has expired,
 * this hook blocks the action and logs a scope violation to the audit trail.
 *
 * The hook is registered on all tools ("*" matcher) and runs synchronously
 * before the tool executes. Blocking is the default — if the identity cannot
 * be validated, the tool call is denied.
 *
 * Audit events emitted: "scope.violation", "tool.blocked", "credential.expired"
 *
 * See docs/architecture/sdlc-agent-architecture-research-v4.md Section 7.4
 * for the scope enforcement logic and hook registration pattern.
 */

// Implementation coming in Phase 1 agent integration work.
