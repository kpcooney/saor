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

/**
 * The environment git runs in: the developer's own configuration is ignored so
 * runs are reproducible, and every variable that tells git *which repository*
 * to act on is removed. Git exports those (`GIT_DIR` and friends) to hooks and
 * to `git rebase --exec`; if they leaked through, the commands below would
 * ignore their working directory and rewrite the HEAD of the repository the
 * tests were launched from.
 *
 * `/dev/null` as the global config is POSIX-only, which matches the platforms
 * Saor is developed on.
 */
function gitEnvironment(): NodeJS.ProcessEnv {
  const repositoryLocators = [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_COMMON_DIR',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_NAMESPACE',
    'GIT_PREFIX',
  ];
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  };
  for (const name of repositoryLocators) {
    delete environment[name];
  }
  return environment;
}

export interface TempProject {
  /** Absolute, symlink-resolved project root. */
  readonly root: string;
  /** A file-backed audit logger appending to this project's audit file. */
  readonly auditLogger: JsonlAuditLogger;
  /** Every audit event persisted so far, read back from disk in order. */
  readonly readAudit: () => AuditEvent[];
  /** Absolute path of a project-relative file. Normalizes `..` segments. */
  readonly pathOf: (relativePath: string) => string;
  /** Point the repository's HEAD at a branch, as `git switch` would. */
  readonly checkOut: (branch: string) => void;
  /** Delete the project directory. */
  readonly remove: () => void;
}

/**
 * Create a temp project whose git repository has `branch` checked out. The
 * repository has no commits; HEAD names the branch, which is all the scope
 * hook reads. If git cannot set the repository up, the directory is removed
 * and the error names the cause.
 */
export function createTempProject(branch: string): TempProject {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'saor-acceptance-')));
  const remove = (): void => rmSync(root, { recursive: true, force: true });
  const environment = gitEnvironment();
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: root, env: environment, stdio: 'pipe' });
  };
  const checkOut = (name: string): void => git('symbolic-ref', 'HEAD', `refs/heads/${name}`);

  try {
    // `init` then `symbolic-ref`, not `init -b`, which needs git 2.28 or newer.
    git('init', '-q');
    checkOut(branch);
  } catch (error) {
    remove();
    throw new Error(`could not create a git repository for the acceptance tests in ${root}`, {
      cause: error,
    });
  }

  const auditPath = join(root, 'audit.jsonl');
  return {
    root,
    auditLogger: new JsonlAuditLogger(auditPath),
    readAudit: () => readAuditEvents(auditPath),
    pathOf: (relativePath) => join(root, relativePath),
    checkOut,
    remove,
  };
}
