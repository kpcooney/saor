// identity/scope.rs
//
// Scope validation logic for AgentIdentity. Implements the checks that
// determine whether a proposed agent action (write to a file, invoke a tool)
// falls within the agent's declared scope restrictions.
//
// Key functions (to be implemented):
//   - matches_file_glob: checks a file path against an agent's allowed glob patterns
//   - tool_is_allowed: checks a tool name against the agent's tool allowlist
//   - credential_is_valid: checks that the agent's credential has not expired
//
// Glob matching uses standard glob syntax (e.g., "src/**", "docs/ux/**").
// The implementation should handle both absolute and project-relative paths.
//
// See docs/architecture/sdlc-agent-architecture-research-v4.md Section 7.4
// for the scope enforcement hook logic that calls these functions.

// Implementation coming in Phase 1 agent identity work.
