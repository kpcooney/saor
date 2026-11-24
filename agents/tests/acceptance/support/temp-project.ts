/**
 * agents/tests/acceptance/support/temp-project.ts
 *
 * A throwaway project on the real filesystem for acceptance tests: a temp
 * directory holding a real git repository and a real JSONL audit file. Nothing
 * here is a mock — the hooks under test read the checked-out branch from the
 * repository's files and append audit events to disk, and the tests read both
 * back.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AuditEvent } from '../../../src/hooks/audit-logger.js';
import { JsonlAuditLogger, readAuditEvents } from '../../support/jsonl-audit-logger.js';

/** Git ignores the developer's own configuration, so runs are reproducible. */
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

export interface TempProject {
  /** Absolute, symlink-resolved project root. */
  readonly root: string;
  /** A file-backed audit logger appending to this project's audit file. */
  readonly auditLogger: JsonlAuditLogger;
  /** Every audit event persisted so far, read back from disk in order. */
  readonly readAudit: () => AuditEvent[];
  /** Absolute path of a project-relative file. */
  readonly pathOf: (relativePath: string) => string;
  /** Point the repository's HEAD at a branch, as `git switch` would. */
  readonly checkOut: (branch: string) => void;
  /** Delete the project directory. */
  readonly remove: () => void;
}

/**
 * Create a temp project whose git repository has `branch` checked out. The
 * repository has no commits; HEAD names the branch, which is all the scope
 * hook reads.
 */
export function createTempProject(branch: string): TempProject {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'saor-acceptance-')));
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: root, env: GIT_ENV, stdio: 'pipe' });
  };
  git('init', '-q', '-b', branch);

  const auditPath = join(root, 'audit.jsonl');
  return {
    root,
    auditLogger: new JsonlAuditLogger(auditPath),
    readAudit: () => readAuditEvents(auditPath),
    pathOf: (relativePath) => join(root, relativePath),
    checkOut: (name) => git('symbolic-ref', 'HEAD', `refs/heads/${name}`),
    remove: () => rmSync(root, { recursive: true, force: true }),
  };
}
