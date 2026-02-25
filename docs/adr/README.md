# docs/adr/

Architectural Decision Records (ADRs) capture significant decisions made during the design and development of Saor. Each ADR documents the context that motivated the decision, the options that were considered, the chosen approach, and the consequences of that choice. They are the project's institutional memory for *why* things are built the way they are.

**Naming convention**: `NNN-short-title.md`, zero-padded to three digits (e.g., `001-audit-store-scoping.md`, `002-memory-store-backend.md`). The number is assigned sequentially. The short title should be a hyphenated summary of the decision being made, not the outcome.

The template for new ADRs is in [`template.md`](template.md). ADRs go through the normal PR workflow — branch, write, open a PR for review, Kevin merges. Do not merge your own ADRs. ADRs in `proposed` status have been written but not yet reviewed; `accepted` means merged to main.
