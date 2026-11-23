/**
 * agents/tests/sandbox/bash-sandbox.test.ts
 *
 * Tests for the Bash sandbox configuration builder (issue #56, ADR-010). The
 * builder is pure — a scope plus a directory listing in, sandbox settings out —
 * so it is tested directly against a fabricated project tree.
 *
 * These verify the configuration Saor hands to the SDK. That the operating
 * system then enforces it is covered by the live check in
 * agents/src/verify-bash-sandbox.ts, not here.
 */

import { describe, expect, it } from 'vitest';

import {
  buildBashSandboxSettings,
  computeDeniedWritePaths,
  isBashSandboxAvailable,
  writableRootOfGlob,
} from '../../src/sandbox/bash-sandbox.js';

const ROOT = '/workspace/saor';

/** A fabricated project tree: absolute directory → entry names. */
const TREE: Record<string, readonly string[]> = {
  [ROOT]: ['.git', '.sdlc', 'CLAUDE.md', 'README.md', 'agents', 'docs', 'src', 'src-tauri'],
  [`${ROOT}/agents`]: ['dist', 'node_modules', 'package.json', 'src', 'tests'],
  [`${ROOT}/src-tauri`]: ['Cargo.toml', 'src', 'target', 'tauri.conf.json'],
  [`${ROOT}/docs`]: ['adr'],
  '/Users/dev/.claude': ['.credentials.json', 'projects', 'settings.json', 'shell-snapshots'],
};

const visited: string[] = [];
function listDirectory(absolutePath: string): readonly string[] {
  visited.push(absolutePath);
  return TREE[absolutePath] ?? [];
}

const CODE_AGENT_GLOBS = ['src/**', 'src-tauri/src/**', 'agents/src/**'];
const BUILD_DIRS = ['agents/dist', 'agents/node_modules', 'src-tauri/target'];

describe('writableRootOfGlob', () => {
  it('reduces a glob to its literal directory prefix', () => {
    expect(writableRootOfGlob('src/**')).toBe('src');
    expect(writableRootOfGlob('src-tauri/src/**')).toBe('src-tauri/src');
    expect(writableRootOfGlob('agents/src/**/*.ts')).toBe('agents/src');
    expect(writableRootOfGlob('docs/*.md')).toBe('docs');
    expect(writableRootOfGlob('README.md')).toBe('README.md');
  });

  it('yields the whole project for a glob with no literal prefix', () => {
    expect(writableRootOfGlob('**/*.ts')).toBe('');
    expect(writableRootOfGlob('*')).toBe('');
  });
});

describe('computeDeniedWritePaths', () => {
  it('denies every existing entry that is outside the writable roots', () => {
    const roots = [...CODE_AGENT_GLOBS.map(writableRootOfGlob), ...BUILD_DIRS];

    expect(computeDeniedWritePaths(ROOT, roots, listDirectory)).toEqual([
      '.git',
      '.sdlc',
      'CLAUDE.md',
      'README.md',
      'agents/package.json',
      'agents/tests',
      'docs',
      'src-tauri/Cargo.toml',
      'src-tauri/tauri.conf.json',
    ]);
  });

  it('descends only into directories that lead to a writable root', () => {
    visited.length = 0;
    const roots = CODE_AGENT_GLOBS.map(writableRootOfGlob);

    computeDeniedWritePaths(ROOT, roots, listDirectory);

    // `docs` is denied whole, so its contents are never listed; `src` is
    // writable whole, so neither are its.
    expect(visited.sort()).toEqual([ROOT, `${ROOT}/agents`, `${ROOT}/src-tauri`]);
  });

  it('does not treat a sibling with a shared name prefix as writable', () => {
    const tree: Record<string, readonly string[]> = { [ROOT]: ['src', 'src-tauri', 'srcs'] };

    const denied = computeDeniedWritePaths(ROOT, ['src'], (dir) => tree[dir] ?? []);

    expect(denied).toEqual(['src-tauri', 'srcs']);
  });

  it('denies nothing when the whole project is writable', () => {
    expect(computeDeniedWritePaths(ROOT, [''], listDirectory)).toEqual([]);
  });
});

describe('buildBashSandboxSettings', () => {
  const settings = buildBashSandboxSettings({
    projectRoot: ROOT,
    writableGlobs: CODE_AGENT_GLOBS,
    buildOutputDirs: BUILD_DIRS,
    homeDir: '/Users/dev',
    listDirectory,
  });

  it('enables the sandbox and refuses the per-command opt-out', () => {
    expect(settings.enabled).toBe(true);
    expect(settings.allowUnsandboxedCommands).toBe(false);
  });

  it('allows no network domains', () => {
    expect(settings.network?.allowedDomains).toEqual([]);
  });

  it('denies writes to out-of-scope paths, as absolute sandbox paths', () => {
    const denyWrite = settings.filesystem?.denyWrite ?? [];

    // `//` marks a path from the filesystem root in SDK sandbox settings.
    expect(denyWrite).toContain(`/${ROOT}/docs`);
    expect(denyWrite).toContain(`/${ROOT}/CLAUDE.md`);
    expect(denyWrite).toContain(`/${ROOT}/.git`);
    expect(denyWrite).toContain(`/${ROOT}/.sdlc`);
    expect(denyWrite).toContain(`/${ROOT}/src-tauri/Cargo.toml`);
    expect(denyWrite.every((path) => path.startsWith(`/${ROOT}/`))).toBe(true);
  });

  it('leaves the file scope and build output directories writable', () => {
    const denyWrite = settings.filesystem?.denyWrite ?? [];

    for (const writable of ['src', 'src-tauri/src', 'agents/src', 'src-tauri/target', 'agents/dist']) {
      const absolute = `/${ROOT}/${writable}`;
      const isDenied = denyWrite.some((path) => path === absolute || absolute.startsWith(`${path}/`));
      expect(isDenied, writable).toBe(false);
    }
  });

  it('denies reads of credentials and of the project protected paths', () => {
    const denyRead = settings.filesystem?.denyRead ?? [];

    expect(denyRead).toContain('//Users/dev/.ssh');
    expect(denyRead).toContain('//Users/dev/.aws');
    expect(denyRead).toContain('//Users/dev/.claude.json');
    expect(denyRead).toContain(`/${ROOT}/.env`);
    expect(denyRead).toContain(`/${ROOT}/**/.env`);
    expect(denyRead).toContain(`/${ROOT}/.sdlc`);
    expect(denyRead).toContain(`/${ROOT}/.claude/settings.local.json`);
  });

  it('emits every project rule for the real path too when the root is symlinked', () => {
    const symlinked = buildBashSandboxSettings({
      projectRoot: ROOT,
      realProjectRoot: `/private${ROOT}`,
      writableGlobs: CODE_AGENT_GLOBS,
      buildOutputDirs: BUILD_DIRS,
      homeDir: '/Users/dev',
      listDirectory,
    });

    const denyWrite = symlinked.filesystem?.denyWrite ?? [];
    expect(denyWrite).toContain(`/${ROOT}/docs`);
    expect(denyWrite).toContain(`//private${ROOT}/docs`);
    expect(denyWrite).toHaveLength(2 * (settings.filesystem?.denyWrite ?? []).length);
    expect(symlinked.filesystem?.denyRead).toContain(`//private${ROOT}/.sdlc`);
  });

  it('protects the Claude CLI state directory except the shell snapshots it must read', () => {
    const denyRead = settings.filesystem?.denyRead ?? [];

    // Settings can hold tokens; projects holds other sessions' transcripts.
    expect(denyRead).toContain('//Users/dev/.claude/settings.json');
    expect(denyRead).toContain('//Users/dev/.claude/.credentials.json');
    expect(denyRead).toContain('//Users/dev/.claude/projects');
    // The CLI sources a snapshot from here at the start of every command; with
    // the whole directory denied, every command printed a permission error.
    expect(denyRead).not.toContain('//Users/dev/.claude/shell-snapshots');
    expect(denyRead).not.toContain('//Users/dev/.claude');
  });

  it('tolerates a trailing slash on the project root', () => {
    const withSlash = buildBashSandboxSettings({
      projectRoot: `${ROOT}/`,
      writableGlobs: CODE_AGENT_GLOBS,
      buildOutputDirs: BUILD_DIRS,
      homeDir: '/Users/dev',
      listDirectory,
    });
    expect(withSlash.filesystem?.denyWrite).toEqual(settings.filesystem?.denyWrite);
  });
});

describe('isBashSandboxAvailable', () => {
  const none = () => false;

  it('is available on macOS, which ships its sandbox', () => {
    expect(isBashSandboxAvailable({ platform: 'darwin', hasCommand: none })).toBe(true);
  });

  it('needs both bubblewrap and socat on Linux', () => {
    const having = (...names: string[]) => (name: string) => names.includes(name);
    expect(isBashSandboxAvailable({ platform: 'linux', hasCommand: having('bwrap', 'socat') })).toBe(true);
    expect(isBashSandboxAvailable({ platform: 'linux', hasCommand: having('bwrap') })).toBe(false);
    expect(isBashSandboxAvailable({ platform: 'linux', hasCommand: none })).toBe(false);
  });

  it('is unavailable everywhere else', () => {
    expect(isBashSandboxAvailable({ platform: 'win32', hasCommand: () => true })).toBe(false);
  });
});
