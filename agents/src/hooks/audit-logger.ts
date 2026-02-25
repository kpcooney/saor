/**
 * agents/src/hooks/audit-logger.ts
 *
 * PostToolUse hook that automatically logs every agent action to the audit
 * trail. This hook is the primary source of "tool.invoked" and
 * "tool.completed" audit events. Agents do not opt in to auditing — it is
 * a side effect of the hook system that fires unconditionally after each
 * tool call completes.
 *
 * The hook captures: which agent ran the tool (via delegation chain),
 * what tool was called and with what parameters, the outcome (success or
 * failure), and traceability references (issue, session).
 *
 * See docs/architecture/sdlc-agent-architecture-research-v4.md Section 8
 * for the audit trail design and Section 8.5 for how hooks populate it.
 */

// Implementation coming in Phase 1 agent integration work.
