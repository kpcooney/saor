/**
 * agents/tests/support/fake-filesystem.ts
 *
 * An in-memory file tree for tests of code that reads the filesystem through
 * injected `readTextFile` / `listDirectory` functions (the git branch-state
 * readers and the Bash sandbox builder). Declared as a flat map of absolute
 * file path → contents; directories exist implicitly as the parents of files.
 */

export interface FakeFilesystem {
  /** File contents, or `undefined` for a missing path or a directory. */
  readonly readTextFile: (absolutePath: string) => string | undefined;
  /** Entry names directly inside a directory; empty for a file or a missing path. */
  readonly listDirectory: (absolutePath: string) => readonly string[];
}

export function fakeFilesystem(files: Readonly<Record<string, string>>): FakeFilesystem {
  const paths = Object.keys(files);
  return {
    readTextFile: (absolutePath) => files[absolutePath],
    listDirectory: (absolutePath) => {
      const prefix = `${absolutePath.replace(/\/$/, '')}/`;
      const entries = paths
        .filter((path) => path.startsWith(prefix))
        .map((path) => path.slice(prefix.length).split('/')[0]!);
      return [...new Set(entries)].sort();
    },
  };
}

/**
 * The files of a git repository at `root` with `branch` checked out. `loose`
 * branches get a ref file each; `packed` branches appear only in `packed-refs`.
 */
export function gitRepositoryFiles(
  root: string,
  branch: string,
  options: { loose?: readonly string[]; packed?: readonly string[] } = {},
): Record<string, string> {
  const sha = 'a'.repeat(40);
  const files: Record<string, string> = {
    [`${root}/.git/HEAD`]: `ref: refs/heads/${branch}\n`,
    [`${root}/.git/config`]: '[core]\n',
  };
  for (const name of new Set([branch, ...(options.loose ?? [])])) {
    files[`${root}/.git/refs/heads/${name}`] = `${sha}\n`;
  }
  if (options.packed !== undefined) {
    files[`${root}/.git/packed-refs`] = [
      '# pack-refs with: peeled fully-peeled sorted',
      ...options.packed.map((name) => `${sha} refs/heads/${name}`),
      `${sha} refs/tags/v1.0`,
      `^${sha}`,
      '',
    ].join('\n');
  }
  return files;
}
