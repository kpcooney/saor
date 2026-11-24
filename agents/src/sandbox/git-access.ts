/**
 * agents/src/sandbox/git-access.ts
 *
 * Decides whether an agent's Bash commands may write to the project's `.git`
 * directory — that is, whether the agent can commit — and gathers what the
 * sandbox needs to keep that access to one branch (issue #58, ADR-011).
 *
 * An agent may commit only when all of these hold at launch:
 *
 *   - the project is a git repository whose directory is `<project>/.git`
 *     (a linked worktree, whose repository lives elsewhere, is not granted
 *     commit access);
 *   - a branch is checked out (not a detached HEAD); and
 *   - that branch matches the agent's `scope.branches`.
 *
 * Otherwise this returns `undefined` and `.git` stays unwritable, as it is for
 * any other path outside the agent's file scope.
 */

import { posix as posixPath } from 'node:path';

import {
  parsePackedBranchNames,
  readBranchState,
  resolveGitDir,
  type ReadTextFile,
} from '../git/branch-state.js';
import { branchIsInScope } from '../hooks/scope-enforcement.js';

/** What the Bash sandbox needs in order to allow commits on one branch. */
export interface BashGitAccess {
  /** The branch checked out at launch: the only one the agent may commit to. */
  readonly committableBranch: string;
  /**
   * Every other branch that exists, loose or packed. The sandbox denies writes
   * to each one's ref so the agent cannot move it.
   */
  readonly otherBranches: readonly string[];
}

/** Inputs to {@link resolveBashGitAccess}. */
export interface GitAccessInput {
  /** Absolute path of the project root. */
  readonly projectRoot: string;
  /** The agent's branch-scope globs (`AgentScope.branches`). */
  readonly branchScope: readonly string[];
  readonly readTextFile: ReadTextFile;
  /** Lists a directory's entry names; empty if it is missing or is a file. */
  readonly listDirectory: (absolutePath: string) => readonly string[];
}

/**
 * The branches stored as loose files under `refs/heads/`. A branch name can
 * contain slashes, in which case it is a file nested in directories; an entry
 * with nothing inside it is taken to be a branch file.
 */
export function listLooseBranchNames(
  headsDir: string,
  listDirectory: (absolutePath: string) => readonly string[],
): string[] {
  const names: string[] = [];

  function visit(relativeDir: string): void {
    const absoluteDir = relativeDir === '' ? headsDir : posixPath.join(headsDir, relativeDir);
    for (const entry of [...listDirectory(absoluteDir)].sort()) {
      const relativePath = relativeDir === '' ? entry : `${relativeDir}/${entry}`;
      const isDirectory = listDirectory(posixPath.join(headsDir, relativePath)).length > 0;
      if (isDirectory) {
        visit(relativePath);
      } else {
        names.push(relativePath);
      }
    }
  }

  visit('');
  return names;
}

/**
 * Work out whether the agent may commit, and to what. Returns `undefined` when
 * it may not (see the module header for the conditions).
 */
export function resolveBashGitAccess(input: GitAccessInput): BashGitAccess | undefined {
  const projectRoot = input.projectRoot.replace(/\\/g, '/').replace(/\/$/, '');
  const gitDir = resolveGitDir(projectRoot, input.readTextFile);
  if (gitDir !== posixPath.join(projectRoot, '.git')) {
    return undefined;
  }

  const branch = readBranchState(projectRoot, input.readTextFile);
  if (branch.kind !== 'branch' || !branchIsInScope(branch.name, input.branchScope)) {
    return undefined;
  }

  const allBranches = new Set([
    ...listLooseBranchNames(posixPath.join(gitDir, 'refs', 'heads'), input.listDirectory),
    ...parsePackedBranchNames(input.readTextFile(posixPath.join(gitDir, 'packed-refs')) ?? ''),
  ]);
  allBranches.delete(branch.name);

  return { committableBranch: branch.name, otherBranches: [...allBranches].sort() };
}
