/**
 * agents/src/git/branch-state.ts
 *
 * Reads which branch a project has checked out, and which branches exist,
 * straight from the repository's files — no `git` subprocess. The scope hook
 * asks before every write whether the agent is on a branch it is scoped to, so
 * this has to be cheap and free of side effects (issue #58, ADR-011).
 *
 * Only the plain layout is understood: a `.git` directory, or a `.git` file
 * pointing at one (`gitdir: …`, as in a linked worktree). Anything else reads
 * as "not a repository".
 */

import { posix as posixPath } from 'node:path';

/**
 * What a project has checked out.
 *
 *   - `branch`   — HEAD points at a branch.
 *   - `detached` — HEAD points straight at a commit; there is no branch to
 *                  compare against a branch scope.
 *   - `none`     — the project is not a git repository, so branch scope does
 *                  not apply to it.
 */
export type BranchState =
  | { readonly kind: 'branch'; readonly name: string }
  | { readonly kind: 'detached' }
  | { readonly kind: 'none' };

/**
 * Reads a file as UTF-8 text, or returns `undefined` if it does not exist or
 * cannot be read. Injected so the readers below are testable without a
 * filesystem.
 */
export type ReadTextFile = (absolutePath: string) => string | undefined;

const BRANCH_REF_PREFIX = 'refs/heads/';

function normalize(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/$/, '');
}

/**
 * The repository directory belonging to exactly this directory: `<dir>/.git`
 * when that is a directory holding `HEAD`, or the directory a `.git` *file*
 * points to. `undefined` when there is neither.
 */
function gitDirAt(directory: string, readTextFile: ReadTextFile): string | undefined {
  const dotGit = posixPath.join(directory, '.git');
  if (readTextFile(posixPath.join(dotGit, 'HEAD')) !== undefined) {
    return dotGit;
  }

  // A linked worktree or submodule: `.git` is a file naming the real directory.
  const pointer = readTextFile(dotGit);
  const match = pointer === undefined ? null : /^gitdir:\s*(.+)$/m.exec(pointer);
  if (match === null) {
    return undefined;
  }
  const target = normalize(match[1]!.trim());
  const gitDir = posixPath.isAbsolute(target) ? target : posixPath.join(directory, target);
  return readTextFile(posixPath.join(gitDir, 'HEAD')) === undefined ? undefined : gitDir;
}

/**
 * Locate the repository directory governing `startDirectory`, searching it and
 * then each parent in turn, the way git itself does. Returns `undefined` when
 * no enclosing directory is a repository.
 *
 * The upward search matters: the directory the hook is told about can be a
 * subdirectory of the project (a shell that has `cd`'d), and reading that as
 * "not a repository" would switch branch enforcement off.
 */
export function resolveGitDir(
  startDirectory: string,
  readTextFile: ReadTextFile,
): string | undefined {
  let directory = normalize(startDirectory);
  for (;;) {
    const gitDir = gitDirAt(directory, readTextFile);
    if (gitDir !== undefined) {
      return gitDir;
    }
    const parent = posixPath.dirname(directory);
    if (parent === directory) {
      return undefined;
    }
    directory = parent;
  }
}

/** Determine what the repository governing `directory` has checked out. */
export function readBranchState(directory: string, readTextFile: ReadTextFile): BranchState {
  const gitDir = resolveGitDir(directory, readTextFile);
  if (gitDir === undefined) {
    return { kind: 'none' };
  }
  const head = (readTextFile(posixPath.join(gitDir, 'HEAD')) ?? '').trim();
  const ref = /^ref:\s*(.+)$/.exec(head)?.[1]?.trim();
  if (ref !== undefined && ref.startsWith(BRANCH_REF_PREFIX)) {
    return { kind: 'branch', name: ref.slice(BRANCH_REF_PREFIX.length) };
  }
  // A bare commit id, or a ref that is not a branch.
  return { kind: 'detached' };
}

/**
 * The names of branches recorded in a `packed-refs` file. Git stores a branch
 * either as a loose file under `refs/heads/` or as a line here; a branch that
 * exists only here has no file to find by listing the directory.
 */
export function parsePackedBranchNames(packedRefs: string): string[] {
  const names: string[] = [];
  for (const line of packedRefs.split('\n')) {
    // Lines are "<sha> <refname>"; '#' starts a header and '^' a peeled tag.
    const refName = /^[0-9a-f]+ (\S+)$/.exec(line.trim())?.[1];
    if (refName !== undefined && refName.startsWith(BRANCH_REF_PREFIX)) {
      names.push(refName.slice(BRANCH_REF_PREFIX.length));
    }
  }
  return names;
}
