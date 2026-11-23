/**
 * agents/tests/sandbox/git-under-sandbox.test.ts
 *
 * Checks the claim at the heart of issue #58 / ADR-011 against real git and the
 * real operating-system sandbox: under the `.git` write rules Saor generates,
 * an agent can commit to the checked-out branch but cannot switch branches or
 * move any other branch.
 *
 * The test creates a real repository in a temp directory, builds the sandbox
 * settings for it with the production code, and runs real `git` commands under
 * macOS's `sandbox-exec` with those deny rules applied. No LLM and no SDK are
 * involved — so this verifies the rules and git's behavior under them, not the
 * SDK's translation of the settings into its own sandbox profile. That last
 * step is covered by the live check (agents/src/verify-bash-sandbox.ts).
 *
 * macOS only: it drives Seatbelt directly. It is skipped, visibly, elsewhere.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildBashSandboxSettings } from '../../src/sandbox/bash-sandbox.js';
import { resolveBashGitAccess } from '../../src/sandbox/git-access.js';

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Probe',
  GIT_AUTHOR_EMAIL: 'probe@example.invalid',
  GIT_COMMITTER_NAME: 'Probe',
  GIT_COMMITTER_EMAIL: 'probe@example.invalid',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

const FEATURE = '58/feature';

describe.skipIf(process.platform !== 'darwin')('git under the generated sandbox rules', () => {
  let root: string;
  let profile: string;

  function git(...args: string[]): string {
    return execFileSync('git', args, { cwd: root, env: GIT_ENV, encoding: 'utf8' }).trim();
  }

  /** Run git inside the sandbox; returns its exit status and combined output. */
  function sandboxedGit(...args: string[]): { status: number | null; output: string } {
    const result = spawnSync('sandbox-exec', ['-p', profile, 'git', ...args], {
      cwd: root,
      env: GIT_ENV,
      encoding: 'utf8',
    });
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  }

  beforeAll(() => {
    // Real path: Seatbelt matches rules against resolved paths (/private/var/…).
    root = realpathSync(mkdtempSync(join(tmpdir(), 'saor-git-sandbox-')));
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
    git('init', '-q', '-b', 'main');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    git('branch', 'loose-other');
    git('branch', 'packed-other');
    git('pack-refs', '--all');
    // After packing, re-create one loose ref so both storage forms are present.
    git('update-ref', 'refs/heads/loose-other', 'HEAD');
    git('checkout', '-q', '-b', FEATURE);
    // Give `main` a commit the feature branch lacks, so that merging or rebasing
    // onto it is a real operation rather than a no-op.
    git('checkout', '-q', 'main');
    writeFileSync(join(root, 'src', 'main-only.ts'), 'export const fromMain = true;\n');
    git('add', '.');
    git('commit', '-q', '-m', 'advance main');
    git('checkout', '-q', FEATURE);

    const listDirectory = (absolutePath: string): readonly string[] => {
      try {
        return readdirSync(absolutePath);
      } catch {
        return [];
      }
    };
    const readTextFile = (absolutePath: string): string | undefined => {
      try {
        return readFileSync(absolutePath, 'utf8');
      } catch {
        return undefined;
      }
    };

    const access = resolveBashGitAccess({
      projectRoot: root,
      branchScope: ['58/*'],
      readTextFile,
      listDirectory,
    });
    expect(access, 'the feature branch is in scope, so commit access is granted').toBeDefined();
    expect(access!.otherBranches).toEqual(['loose-other', 'main', 'packed-other']);

    const settings = buildBashSandboxSettings({
      projectRoot: root,
      writableGlobs: ['src/**'],
      buildOutputDirs: [],
      homeDir: '/nonexistent-home',
      listDirectory,
      git: access!,
    });

    // The settings spell absolute paths with a leading `//`; Seatbelt wants `/`.
    const denied = (settings.filesystem?.denyWrite ?? []).map((path) => path.replace(/^\/\//, '/'));
    const rules = denied.map((path) => `(subpath ${JSON.stringify(path)})`).join(' ');
    profile = `(version 1)(allow default)(deny file-write* ${rules})`;
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('lets the agent commit to the checked-out branch', () => {
    const before = git('rev-parse', 'HEAD');
    writeFileSync(join(root, 'src', 'b.ts'), 'export const b = 2;\n');

    expect(sandboxedGit('add', 'src/b.ts').status).toBe(0);
    const commit = sandboxedGit('commit', '-q', '-m', 'work on the feature branch');

    expect(commit.status, commit.output).toBe(0);
    expect(git('rev-parse', 'HEAD')).not.toBe(before);
    expect(git('rev-parse', '--abbrev-ref', 'HEAD')).toBe(FEATURE);
    expect(git('log', '-1', '--format=%s')).toBe('work on the feature branch');
  });

  it('keeps everyday operations on the current branch working', () => {
    // Amend.
    const amend = sandboxedGit('commit', '-q', '--amend', '-m', 'amended on the feature branch');
    expect(amend.status, amend.output).toBe(0);
    expect(git('log', '-1', '--format=%s')).toBe('amended on the feature branch');

    // Stash and restore.
    writeFileSync(join(root, 'src', 'b.ts'), 'export const b = 3;\n');
    const stash = sandboxedGit('stash');
    expect(stash.status, stash.output).toBe(0);
    const pop = sandboxedGit('stash', 'pop');
    expect(pop.status, pop.output).toBe(0);
    expect(readFileSync(join(root, 'src', 'b.ts'), 'utf8')).toContain('b = 3');

    // Commit that change, then undo the commit with a reset.
    expect(sandboxedGit('commit', '-q', '-am', 'second').status).toBe(0);
    const tip = git('rev-parse', 'HEAD');
    const reset = sandboxedGit('reset', '-q', '--hard', 'HEAD~1');
    expect(reset.status, reset.output).toBe(0);
    expect(git('rev-parse', 'HEAD')).not.toBe(tip);
  });

  it('refuses a rebase, which has to move HEAD', () => {
    const before = git('rev-parse', FEATURE);

    const rebase = sandboxedGit('rebase', 'main');

    expect(rebase.status, rebase.output).not.toBe(0);
    expect(git('rev-parse', '--abbrev-ref', 'HEAD')).toBe(FEATURE);
    expect(git('rev-parse', FEATURE)).toBe(before);
    // Clear any half-started rebase state so later tests start clean.
    spawnSync('git', ['rebase', '--abort'], { cwd: root, env: GIT_ENV });
    git('reset', '-q', '--hard', FEATURE);
  });

  it('lets the agent merge another branch into the current one', () => {
    const mainTip = git('rev-parse', 'main');

    const merge = sandboxedGit('merge', '-q', '--no-edit', 'main');

    expect(merge.status, merge.output).toBe(0);
    expect(git('rev-parse', '--abbrev-ref', 'HEAD')).toBe(FEATURE);
    // The feature branch now contains main's commit; main itself did not move.
    expect(git('merge-base', '--is-ancestor', 'main', 'HEAD')).toBe('');
    expect(git('rev-parse', 'main')).toBe(mainTip);
  });

  it('refuses to switch branches', () => {
    for (const args of [
      ['checkout', 'main'],
      ['switch', 'loose-other'],
      ['symbolic-ref', 'HEAD', 'refs/heads/main'],
      ['checkout', '--detach'],
    ]) {
      const result = sandboxedGit(...args);
      expect(result.status, `git ${args.join(' ')}: ${result.output}`).not.toBe(0);
    }
    expect(git('rev-parse', '--abbrev-ref', 'HEAD')).toBe(FEATURE);
  });

  it('refuses to move or delete any other branch, loose or packed', () => {
    const before = {
      main: git('rev-parse', 'main'),
      loose: git('rev-parse', 'loose-other'),
      packed: git('rev-parse', 'packed-other'),
    };

    for (const args of [
      ['update-ref', 'refs/heads/main', 'HEAD'],
      ['branch', '-f', 'loose-other', 'HEAD'],
      ['branch', '-f', 'packed-other', 'HEAD'],
      ['branch', '-D', 'packed-other'],
      ['branch', '-D', 'loose-other'],
    ]) {
      const result = sandboxedGit(...args);
      expect(result.status, `git ${args.join(' ')}: ${result.output}`).not.toBe(0);
    }

    expect(git('rev-parse', 'main')).toBe(before.main);
    expect(git('rev-parse', 'loose-other')).toBe(before.loose);
    expect(git('rev-parse', 'packed-other')).toBe(before.packed);
  });

  it('refuses to write git config or hooks', () => {
    expect(sandboxedGit('config', 'user.name', 'Someone Else').status).not.toBe(0);

    const hook = spawnSync(
      'sandbox-exec',
      ['-p', profile, 'sh', '-c', 'echo "#!/bin/sh" > .git/hooks/pre-commit'],
      { cwd: root, encoding: 'utf8' },
    );
    expect(hook.status).not.toBe(0);
  });

  it('negative control: the same commands succeed without the sandbox', () => {
    // Proves the refusals above come from the rules, not from the commands.
    git('branch', '-f', 'loose-other', 'HEAD');
    expect(git('rev-parse', 'loose-other')).toBe(git('rev-parse', 'HEAD'));
    git('checkout', '-q', 'main');
    expect(git('rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
  });
});
