/**
 * agents/tests/sandbox/git-access.test.ts
 *
 * Tests for deciding whether an agent's sandboxed Bash may commit, and for the
 * `.git` rules that keep that access to one branch (issue #58, ADR-011).
 *
 * These cover the configuration Saor builds. That git behaves as intended
 * under those rules — commits succeed, branch switches and other-branch
 * updates fail — was checked against real git under the macOS sandbox and is
 * part of the live check (agents/src/verify-bash-sandbox.ts).
 */

import { describe, expect, it } from 'vitest';

import { buildBashSandboxSettings, gitDeniedWritePaths } from '../../src/sandbox/bash-sandbox.js';
import { listLooseBranchNames, resolveBashGitAccess } from '../../src/sandbox/git-access.js';
import { fakeFilesystem, gitRepositoryFiles } from '../support/fake-filesystem.js';

const ROOT = '/workspace/saor';

function accessFor(files: Record<string, string>, branchScope: readonly string[]) {
  const fs = fakeFilesystem(files);
  return resolveBashGitAccess({ projectRoot: ROOT, branchScope, ...fs });
}

describe('resolveBashGitAccess', () => {
  const repo = gitRepositoryFiles(ROOT, '58/enforce-branch-scope', {
    loose: ['main', '56/sandbox-bash'],
    packed: ['main', 'release/1.0'],
  });

  it('grants commit access on an in-scope branch and lists every other branch', () => {
    expect(accessFor(repo, ['58/*'])).toEqual({
      committableBranch: '58/enforce-branch-scope',
      // Loose and packed branches, merged and deduplicated, without the current one.
      otherBranches: ['56/sandbox-bash', 'main', 'release/1.0'],
    });
  });

  it('grants nothing when the checked-out branch is out of scope', () => {
    expect(accessFor(repo, ['59/*'])).toBeUndefined();
    expect(accessFor(gitRepositoryFiles(ROOT, 'main'), ['58/*'])).toBeUndefined();
  });

  it('grants nothing on a detached HEAD or outside a repository', () => {
    expect(accessFor({ [`${ROOT}/.git/HEAD`]: 'd'.repeat(40) }, ['*/*'])).toBeUndefined();
    expect(accessFor({ [`${ROOT}/README.md`]: 'x' }, ['*/*'])).toBeUndefined();
  });

  it('grants nothing when the repository directory is not the project .git', () => {
    // A linked worktree, and a project nested inside someone else's repository.
    const worktree = {
      [`${ROOT}/.git`]: 'gitdir: /repos/saor/.git/worktrees/wt1\n',
      '/repos/saor/.git/worktrees/wt1/HEAD': 'ref: refs/heads/58/x\n',
    };
    const nested = gitRepositoryFiles('/workspace', '58/x');

    expect(accessFor(worktree, ['58/*'])).toBeUndefined();
    expect(accessFor(nested, ['58/*'])).toBeUndefined();
  });
});

describe('listLooseBranchNames', () => {
  it('walks nested ref directories into slash-separated names', () => {
    const { listDirectory } = fakeFilesystem(
      gitRepositoryFiles(ROOT, 'main', { loose: ['56/a', '56/b', 'feature/deep/name'] }),
    );

    expect(listLooseBranchNames(`${ROOT}/.git/refs/heads`, listDirectory)).toEqual([
      '56/a',
      '56/b',
      'feature/deep/name',
      'main',
    ]);
  });
});

describe('Bash sandbox settings with commit access', () => {
  const files = {
    ...gitRepositoryFiles(ROOT, '58/x', { loose: ['main'] }),
    [`${ROOT}/src/a.ts`]: '',
    [`${ROOT}/docs/b.md`]: '',
  };
  const fs = fakeFilesystem(files);
  const base = {
    projectRoot: ROOT,
    writableGlobs: ['src/**'],
    buildOutputDirs: [],
    homeDir: '/Users/dev',
    listDirectory: fs.listDirectory,
  };
  const git = { committableBranch: '58/x', otherBranches: ['main', 'release/1.0'] };

  it('keeps .git unwritable when no commit access is given', () => {
    const denyWrite = buildBashSandboxSettings(base).filesystem?.denyWrite ?? [];

    expect(denyWrite).toContain(`/${ROOT}/.git`);
  });

  it('opens .git but denies HEAD, config, hooks, and every other branch ref', () => {
    const denyWrite = buildBashSandboxSettings({ ...base, git }).filesystem?.denyWrite ?? [];

    expect(denyWrite).not.toContain(`/${ROOT}/.git`);
    for (const denied of [
      '.git/HEAD',
      '.git/packed-refs',
      '.git/config',
      '.git/hooks',
      '.git/refs/tags',
      '.git/refs/remotes',
      '.git/refs/heads/main',
      // A packed-only branch has no ref file yet; its path is denied anyway so
      // that one cannot be created to move it.
      '.git/refs/heads/release/1.0',
    ]) {
      expect(denyWrite, denied).toContain(`/${ROOT}/${denied}`);
    }
    // Still denied as before: an out-of-scope project directory.
    expect(denyWrite).toContain(`/${ROOT}/docs`);
  });

  it('leaves the committable branch ref, objects, and index writable', () => {
    const denied = gitDeniedWritePaths(git);

    for (const needed of ['.git/refs/heads/58/x', '.git/objects', '.git/index', '.git/logs']) {
      const isDenied = denied.some((path) => path === needed || needed.startsWith(`${path}/`));
      expect(isDenied, needed).toBe(false);
    }
  });
});
