/**
 * agents/tests/git/branch-state.test.ts
 *
 * Tests for reading a repository's checked-out branch from its files (issue
 * #58). The readers take an injected `readTextFile`, so they are exercised
 * against an in-memory file tree — plus one check against this repository's
 * real `.git`, so the parsing is known to match what git actually writes.
 */

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  parsePackedBranchNames,
  readBranchState,
  resolveGitDir,
} from '../../src/git/branch-state.js';
import { readTextFileOrUndefined } from '../../src/git/system-git.js';
import { fakeFilesystem, gitRepositoryFiles } from '../support/fake-filesystem.js';

const ROOT = '/workspace/saor';

describe('readBranchState', () => {
  it('reads the checked-out branch, including one with slashes in its name', () => {
    const { readTextFile } = fakeFilesystem(gitRepositoryFiles(ROOT, '58/enforce-branch-scope'));

    expect(readBranchState(ROOT, readTextFile)).toEqual({
      kind: 'branch',
      name: '58/enforce-branch-scope',
    });
  });

  it('reports a detached HEAD when HEAD holds a commit id', () => {
    const { readTextFile } = fakeFilesystem({ [`${ROOT}/.git/HEAD`]: `${'b'.repeat(40)}\n` });

    expect(readBranchState(ROOT, readTextFile)).toEqual({ kind: 'detached' });
  });

  it('reports none for a directory that is not in a repository', () => {
    const { readTextFile } = fakeFilesystem({ [`${ROOT}/README.md`]: 'hello' });

    expect(readBranchState(ROOT, readTextFile)).toEqual({ kind: 'none' });
  });

  it('finds the repository from a subdirectory, as git does', () => {
    // A shell that has cd'd into the project must not read as "no repository".
    const { readTextFile } = fakeFilesystem(gitRepositoryFiles(ROOT, 'main'));

    expect(readBranchState(`${ROOT}/agents/src`, readTextFile)).toEqual({
      kind: 'branch',
      name: 'main',
    });
  });

  it('follows a .git file to a linked worktree repository directory', () => {
    const { readTextFile } = fakeFilesystem({
      [`${ROOT}/.git`]: 'gitdir: /repos/saor/.git/worktrees/wt1\n',
      '/repos/saor/.git/worktrees/wt1/HEAD': 'ref: refs/heads/59/bridge\n',
    });

    expect(resolveGitDir(ROOT, readTextFile)).toBe('/repos/saor/.git/worktrees/wt1');
    expect(readBranchState(ROOT, readTextFile)).toEqual({ kind: 'branch', name: '59/bridge' });
  });

  it('agrees with git about this repository', () => {
    const here = dirname(fileURLToPath(import.meta.url));

    const state = readBranchState(here, readTextFileOrUndefined);

    // Whatever is checked out, this file lives in a git repository.
    expect(state.kind).not.toBe('none');
  });
});

describe('parsePackedBranchNames', () => {
  it('returns branch names and ignores tags, peeled lines, and the header', () => {
    const sha = 'c'.repeat(40);
    const packed = [
      '# pack-refs with: peeled fully-peeled sorted',
      `${sha} refs/heads/56/sandbox-bash`,
      `${sha} refs/heads/main`,
      `${sha} refs/remotes/origin/main`,
      `${sha} refs/tags/v1.0`,
      `^${sha}`,
      '',
    ].join('\n');

    expect(parsePackedBranchNames(packed)).toEqual(['56/sandbox-bash', 'main']);
    expect(parsePackedBranchNames('')).toEqual([]);
  });
});
