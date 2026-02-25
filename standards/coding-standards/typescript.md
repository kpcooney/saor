# TypeScript Coding Standards

These conventions apply to all TypeScript in this project: the `agents/` package and `src/` frontend. Strict mode is non-negotiable. Follow these rules exactly.

## Compiler Settings

- `strict: true` is required in every `tsconfig.json`. No exceptions.
- `noUncheckedIndexedAccess: true` — array and object index access returns `T | undefined`.
- `exactOptionalPropertyTypes: true` — distinguish between a property being absent vs. set to `undefined`.
- `skipLibCheck` may be `true` only to work around upstream type errors; document why if used.
- Never disable strict checks with `// @ts-ignore` or `// @ts-nocheck`. Use explicit type narrowing instead.

## Naming

- **Variables and functions**: `camelCase`
- **Types, interfaces, classes, enums**: `PascalCase`
- **Constants** (module-level, never reassigned): `SCREAMING_SNAKE_CASE`
- **Files**: `kebab-case.ts` (e.g., `scope-enforcement.ts`, `memory-server.ts`)
- **Boolean variables**: prefix with `is`, `has`, `can`, `should` (e.g., `isExpired`, `hasScope`)
- Names should describe what a thing *is* or *does*, not how it is implemented. `resolveStandardWithOverrideChain` is better than `resolve`. `agentDelegationChain` is better than `chain`.

## Types and Interfaces

- Prefer `interface` over `type` aliases for any public contract (anything exported or consumed by other modules). Use `type` for local aliases, union types, and mapped/conditional types where `interface` doesn't apply.
- Export interfaces, not classes, as the primary contract. Classes are an implementation detail.
- Avoid `any`. If you must use it, add a comment explaining why and what type it actually is at runtime: `// eslint-disable-next-line @typescript-eslint/no-explicit-any — SDK callback type is untyped`.
- Avoid `unknown` casts without a type guard function. Write a `isXxx(value: unknown): value is Xxx` guard rather than asserting with `as`.
- Prefer `readonly` on interface fields that should not be mutated after construction.

```typescript
// Correct: interface for public contract, readonly where appropriate
interface AgentIdentity {
  readonly id: string;
  readonly role: string;
  readonly delegationChain: readonly string[];
  scope: AgentScope;         // mutable — scope can be updated
}

// Avoid: type alias for a public contract that could be an interface
type AgentIdentity = { ... };
```

## Functions

- Add explicit return types on all exported functions. The compiler can infer them, but explicit types are documentation.
- Prefer named functions over anonymous arrow functions for top-level exports; use arrows for callbacks and short inline expressions.
- Use early returns to reduce nesting. Guard clauses at the top, happy path at the bottom.
- Limit functions to a single responsibility. If a function is doing five things, split it into named steps.

```typescript
// Correct: explicit return type, early return, clear steps
export function enforceScope(
  toolCall: ToolCall,
  identity: AgentIdentity
): ScopeCheckResult {
  if (!isToolAllowed(toolCall.tool, identity.scope.tools)) {
    return { action: 'block', reason: 'tool not in allowlist' };
  }
  if (isCredentialExpired(identity.expiresAt)) {
    return { action: 'block', reason: 'credential expired' };
  }
  if (!fileIsInScope(toolCall.params?.file_path, identity.scope.files)) {
    return { action: 'block', reason: 'file outside scope' };
  }
  return { action: 'allow' };
}
```

## Error Handling

- Use typed errors. Define an error class or tagged union, not bare `new Error('string')`.
- Never use a bare `catch(e)` that silences errors. Always either re-throw, log with context, or return a typed error result.
- For functions that can fail in expected ways, prefer returning a discriminated union (`{ ok: true; value: T } | { ok: false; error: AppError }`) over throwing.
- Only throw for truly unexpected conditions (programmer errors, not user-facing runtime failures).

```typescript
// Correct: typed result union for expected failures
type ResolveResult =
  | { ok: true; content: string }
  | { ok: false; error: 'not-found' | 'permission-denied' | 'invalid-uri' };

export async function resolveRef(uri: string): Promise<ResolveResult> {
  if (!isValidUri(uri)) {
    return { ok: false, error: 'invalid-uri' };
  }
  // ...
}

// Avoid: throwing for expected failures, bare catch
try {
  const result = resolveRef(uri);
} catch (e) {  // what type is e? what do we do with it?
  console.error(e);
}
```

## Imports

Order imports in three groups, separated by blank lines:

1. Node.js stdlib (`node:fs`, `node:path`, etc.) — use the `node:` prefix
2. External packages (`@anthropic-ai/claude-agent-sdk`, `zod`, etc.)
3. Internal absolute imports (`@saor/agents/...`)
4. Relative imports (`./types`, `../hooks/scope-enforcement`)

Keep imports explicit — do not use barrel `index.ts` re-exports unless the module genuinely has a stable public API surface.

## Async

- Prefer `async/await` over `.then()/.catch()` chains.
- Always `await` promises — never fire-and-forget unless explicitly intentional, and document it if so.
- Handle `Promise.all` rejection: if any promise in the array can fail independently, consider `Promise.allSettled` and check each result.

## Documentation

- Every file must have a module-level JSDoc comment explaining what the module does and where it fits in the system.
- Every exported function, interface, and type must have a JSDoc comment describing its contract (not its implementation).
- Link to the relevant architecture doc section when a module implements something described there.
- Do not document self-evident code (`// increment counter` is noise).
