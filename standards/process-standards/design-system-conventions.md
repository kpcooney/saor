# Design System Conventions

This is a template file. It is expected to be overridden per project via `.sdlc/standards/process-standards/design-system-conventions.md`. Replace this content with the actual design system conventions for the project being built.

In Phase 1, Saor's own UI is minimal — a handful of utility components for the agent dashboard, memory inspector, and audit viewer. The conventions below apply to Saor's own frontend. When Saor is used to build other projects, those projects override this file with their own design system rules.

## Core Principle

Prefer existing components and patterns over creating new ones. Every new component or pattern introduced has a maintenance cost and a consistency cost. Introduce new patterns only when existing ones genuinely cannot satisfy the requirement — and document why.

## Component Usage

- Before writing a new component, check `src/lib/components/` for an existing one that meets the need.
- If an existing component almost works but needs a small change, extend it rather than copying it.
- If a genuinely new pattern is needed, write a component contract (`docs/ux/components/{ComponentName}.md`) before implementing. The contract is the specification; the Svelte file is the implementation.

## Naming Conventions

- Component files: `PascalCase.svelte` (e.g., `MemoryInspector.svelte`, `AgentStatusBadge.svelte`)
- Component names should describe what the component *is*, not how it looks (`AgentStatusBadge`, not `GreenPill`)
- Props: `camelCase`. Boolean props should be named as predicates (`isLoading`, `hasError`, `isDisabled`)

## Component Documentation

- Every component in `src/lib/components/` should have a component contract in `docs/ux/components/` if it was introduced as part of a feature (i.e., it has a UX origin).
- Utility components created purely for technical reasons (layout wrappers, etc.) do not require a full contract but should have a brief JSDoc comment in the Svelte file describing their purpose.

## When a Component Contract Is Required

A contract is required when:
- A new component is introduced as part of a feature (has a corresponding UX flow)
- An existing component is significantly modified — new interaction states, new data requirements, changed keyboard behavior

A contract is not required for:
- Trivial layout wrapper components
- One-off elements that appear in a single place and have no reuse potential

## Phase 1 Design System Status

In Phase 1, the design system is intentionally minimal. The UI exists to validate the backend infrastructure, not to be a polished product. This means:

- Use browser defaults and system fonts — no custom typography or token system yet
- Tailwind CSS (if added) provides the baseline utility classes — keep usage simple
- Favor clarity and functional correctness over visual polish in Phase 1

When the project moves to Phase 2+ and the UI becomes a real product surface, this file should be replaced with:
- A full token system (colors, spacing, typography)
- A component inventory with links to contracts
- Design tool references (Figma, etc.) if applicable
- Specific pattern guidance (which components to use for which patterns)
