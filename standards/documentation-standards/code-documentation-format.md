# Code Documentation Format

How to document code in this project. Documentation should help someone not familiar with the codebase understand what they're looking at. It does not need to be on every function or every line — use judgment about where it adds value.

## Always document

- **Module-level**: every file should have a brief comment (or doc comment) at the top explaining what this module is responsible for and where it fits in the system. Link to the relevant architecture doc section when applicable (e.g., `// See docs/architecture/...v4.md Section 6 for memory architecture`).
- **Public interfaces and types**: describe the contract, not the implementation. For TypeScript interfaces that agents or MCP servers consume, explain what each field means and when it's used.
- **Non-obvious decisions**: if you chose approach A over approach B for a reason, leave a comment explaining why. Future readers (including future agent sessions) will benefit from knowing the rationale.
- **Complex algorithms or data transformations**: if the logic isn't self-evident from reading the code, explain the approach.

## Don't document

- **Self-evident code.** `// increment counter` above `counter++` adds nothing.
- **Every private helper function.** If the name and signature make the purpose clear, that's sufficient.

## Linking to deeper docs

When a module implements something described in the architecture document or an ADR, reference it. This creates traceability between the running code and the design decisions that shaped it.

For naming and structure that make code self-explaining in the first place, see [code-clarity.md](../coding-standards/code-clarity.md).
