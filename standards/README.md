# standards/

This directory contains the system-default standards files that ship with Saor. They form the base layer of the three-tier standards model described in the architecture document (Section 4).

**Resolution order** (highest priority first):

1. **Agent-specific** — standards defined inline in an agent's own definition
2. **Project overrides** — files in `.sdlc/standards/` within a project directory, mirroring this structure
3. **System defaults** — files here in `standards/`

When an agent requests `coding-standards/typescript`, the reference resolver walks this chain and returns the first match. A project can override any system default by placing a file at the same relative path under `.sdlc/standards/`. If no override exists, the system default is used.

The subdirectories map directly to standard categories: `coding-standards/` for language-specific style and conventions, `documentation-standards/` for document formats and templates (ADRs, PRs, issues, UX flows), `process-standards/` for workflow checklists (testing, security, accessibility, code review), and `etiquette/` for interaction conventions (GitHub etiquette).

These files are written for AI agents to consume — they should be concise and actionable. A standards file is not an exhaustive style guide; it is the specific rules an agent must apply when doing its work.
