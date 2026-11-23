/**
 * agents/src/sandbox/protected-paths.ts
 *
 * The paths an agent may never read, whatever its file scope says. Shared by
 * the two layers that confine reads (issue #56, ADR-010):
 *
 *   - the scope-enforcement hook, which checks the explicit target of every
 *     `Read` / `Grep` / `Glob` call against these, and
 *   - the Bash sandbox, which denies them to any command the agent runs.
 *
 * Keeping the lists here means the two layers cannot drift apart.
 */

/**
 * Project-relative globs for files inside the project that hold secrets or
 * system state rather than project content:
 *
 *   - `.env` files — credentials.
 *   - `.claude/settings.local.json` — the developer's local permission
 *     allowlist.
 *   - `.sdlc/` — the memory database and audit trail. An agent reaches those
 *     only through the memory tools, which enforce its memory namespaces;
 *     reading the files directly would bypass that.
 */
export const PROTECTED_PROJECT_GLOBS: readonly string[] = [
  '.env',
  '.env.*',
  '**/.env',
  '**/.env.*',
  '.claude/settings.local.json',
  '.sdlc',
  '.sdlc/**',
];

/**
 * Home-relative paths holding credentials for other services. Reads outside
 * the project are already refused for `Read` / `Grep` / `Glob`; this list is
 * what closes the same door for Bash, whose reads the sandbox confines by deny
 * list only.
 */
export const PROTECTED_HOME_PATHS: readonly string[] = [
  '.ssh',
  '.aws',
  '.gnupg',
  '.netrc',
  '.npmrc',
  '.docker',
  '.kube',
  '.config/gh',
  '.config/gcloud',
  '.claude',
  '.claude.json',
];
