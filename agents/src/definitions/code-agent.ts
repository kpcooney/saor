/**
 * agents/src/definitions/code-agent.ts
 *
 * Agent definition for the Code Agent — the specialist responsible for
 * writing and refactoring source code. In Phase 1, this is the single
 * agent integration used to validate the identity, scope enforcement,
 * and audit hook infrastructure.
 *
 * The Code Agent's scope is restricted to the file globs and tools defined
 * here. Attempts to write outside the allowed globs or invoke disallowed
 * tools are blocked by the PreToolUse scope enforcement hook and logged
 * to the audit trail.
 *
 * See docs/architecture/sdlc-agent-architecture-research-v4.md Section 3.4
 * for the full agent definition table and Section 7 for the identity schema.
 */

// Implementation coming in Phase 1 agent integration work.
