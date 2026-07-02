# Code Clarity

Applies to all languages in the project. Favor readable code over clever or terse code. Someone unfamiliar with the project should be able to read a module and understand what it does without having to reverse-engineer intent from compressed logic.

- **Name things for what they mean**, not for brevity. `resolveStandardWithOverrideChain` is better than `resolve`. A variable called `agentDelegationChain` is better than `chain`.
- **Avoid unnecessary abstraction.** Don't introduce a factory or strategy pattern where a plain function works. The architecture already has enough abstraction layers — the code within each layer should be straightforward.
- **Break up complex logic.** If a function is doing five things, split it into named steps. Each step's name should explain the intent.
- **Use early returns** to reduce nesting. Guard clauses at the top of a function, happy path at the bottom.

Language-specific style lives alongside this file: [typescript.md](typescript.md), [rust.md](rust.md), [python.md](python.md). For where to put explanatory comments, see [code-documentation-format.md](../documentation-standards/code-documentation-format.md).
