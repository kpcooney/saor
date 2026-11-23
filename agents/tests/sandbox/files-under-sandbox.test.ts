/**
 * agents/tests/sandbox/files-under-sandbox.test.ts
 *
 * Checks the file rules of issue #56 / ADR-010 against the real operating-
 * system sandbox: under the write deny list and protected-read list Saor
 * generates for an agent's scope, shell commands can write inside the scope and
 * nowhere else that already exists in the project, and cannot read protected
 * paths.
 *
 * The test builds a real project tree in a temp directory, generates the
 * sandbox settings for it with the production code, and runs real shell
 * commands under macOS's `sandbox-exec` with those rules applied. No LLM and
 * no SDK are involved. So this verifies the rules Saor generates and that the
 * OS honors them — not the two things only the SDK does: confining writes to
 * the project as a whole, and translating these settings into its own sandbox
 * profile. Those are covered by the live check
 * (agents/src/verify-bash-sandbox.ts).
 *
 * macOS only: it drives Seatbelt directly. It is skipped, visibly, elsewhere.
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildBashSandboxSettings } from '../../src/sandbox/bash-sandbox.js';

/** The Code Agent's file scope and the build directories relevant to the tree. */
const WRITABLE_GLOBS = ['src/**', 'src-tauri/src/**'];
const BUILD_OUTPUT_DIRS = ['src-tauri/target'];

const ORIGINAL = 'original\n';
const SECRET = 'do-not-leak\n';

/** Project-relative files the tree starts with. */
const PROJECT_FILES: Readonly<Record<string, string>> = {
  'README.md': ORIGINAL,
  'docs/existing.md': ORIGINAL,
  'src/app.ts': ORIGINAL,
  'src-tauri/Cargo.toml': ORIGINAL,
  'src-tauri/src/lib.rs': ORIGINAL,
  'src-tauri/target/debug/build.log': ORIGINAL,
  '.git/HEAD': 'ref: refs/heads/main\n',
  '.sdlc/audit/2026-11-23.jsonl': SECRET,
  '.env': SECRET,
  '.envrc': 'not a secret\n',
  'packages/api/.env.production': SECRET,
  '.claude/settings.local.json': SECRET,
  '.claude/settings.json': 'shared settings\n',
};

const GLOB_CHARACTERS = /[*?[\]{}]/;

function escapeForRegex(text: string): string {
  return text.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

/**
 * Turn one path from the generated settings into a Seatbelt path filter. The
 * settings spell absolute paths with a leading `//`. A plain path becomes a
 * `subpath` (the path and everything under it); a glob becomes a regex with
 * `**` crossing directories and `*` staying within one.
 */
function seatbeltFilter(settingsPath: string): string {
  const path = settingsPath.replace(/^\/\//, '/').replace(/\/\*\*$/, '');
  if (!GLOB_CHARACTERS.test(path)) {
    return `(subpath ${JSON.stringify(path)})`;
  }
  const pattern = path
    .split(/(\*\*\/|\*\*|\*)/)
    .map((part) => {
      if (part === '**/') return '(.*/)?';
      if (part === '**') return '.*';
      if (part === '*') return '[^/]*';
      return escapeForRegex(part);
    })
    .join('');
  return `(regex #"^${pattern}$")`;
}

describe.skipIf(process.platform !== 'darwin')('files under the generated sandbox rules', () => {
  /** The project root as a caller would give it — through macOS's /var symlink. */
  let givenRoot: string;
  /** The same directory with symlinks resolved, which is what the OS matches. */
  let root: string;
  let home: string;
  let profile: string;

  /** Run a shell command in the project, inside the sandbox. */
  function sandboxed(command: string): { status: number | null; output: string } {
    const result = spawnSync('sandbox-exec', ['-p', profile, 'sh', '-c', command], {
      cwd: root,
      encoding: 'utf8',
    });
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  }

  function contents(relativePath: string): string {
    return readFileSync(join(root, relativePath), 'utf8');
  }

  beforeAll(() => {
    givenRoot = mkdtempSync(join(tmpdir(), 'saor-files-sandbox-'));
    root = realpathSync(givenRoot);
    for (const [relativePath, text] of Object.entries(PROJECT_FILES)) {
      mkdirSync(dirname(join(root, relativePath)), { recursive: true });
      writeFileSync(join(root, relativePath), text);
    }
    home = realpathSync(mkdtempSync(join(tmpdir(), 'saor-files-sandbox-home-')));
    mkdirSync(join(home, '.ssh'));
    writeFileSync(join(home, '.ssh', 'id_rsa'), SECRET);

    const settings = buildBashSandboxSettings({
      projectRoot: givenRoot,
      realProjectRoot: root,
      writableGlobs: WRITABLE_GLOBS,
      buildOutputDirs: BUILD_OUTPUT_DIRS,
      homeDir: home,
      listDirectory: (absolutePath) => {
        try {
          return readdirSync(absolutePath);
        } catch {
          return [];
        }
      },
    });

    const denyWrite = (settings.filesystem?.denyWrite ?? []).map(seatbeltFilter).join(' ');
    const denyRead = (settings.filesystem?.denyRead ?? []).map(seatbeltFilter).join(' ');
    profile = `(version 1)(allow default)(deny file-write* ${denyWrite})(deny file-read* ${denyRead})`;
  });

  afterAll(() => {
    rmSync(givenRoot, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it('allows writes inside the file scope and the build output directories', () => {
    for (const command of [
      'echo changed >> src/app.ts',
      'mkdir -p src/feature && echo new > src/feature/new.ts',
      'echo changed >> src-tauri/src/lib.rs',
      'echo line >> src-tauri/target/debug/build.log',
      'rm src/feature/new.ts',
    ]) {
      const result = sandboxed(command);
      expect(result.status, `${command}: ${result.output}`).toBe(0);
    }
    expect(contents('src/app.ts')).toBe(`${ORIGINAL}changed\n`);
  });

  it('blocks modifying, replacing, or deleting an existing out-of-scope file', () => {
    for (const command of [
      'echo tampered >> docs/existing.md',
      'echo replaced > README.md',
      'rm docs/existing.md',
      'mv docs/existing.md docs/renamed.md',
      'echo tampered >> src-tauri/Cargo.toml',
      'cp src/app.ts README.md',
      'sed -i "" "s/original/tampered/" docs/existing.md',
    ]) {
      const result = sandboxed(command);
      expect(result.status, `${command} should fail`).not.toBe(0);
    }
    expect(contents('docs/existing.md')).toBe(ORIGINAL);
    expect(contents('README.md')).toBe(ORIGINAL);
    expect(contents('src-tauri/Cargo.toml')).toBe(ORIGINAL);
  });

  it('blocks creating anything inside an existing out-of-scope directory', () => {
    for (const command of [
      'echo new > docs/new.md',
      'mkdir docs/sub',
      'echo x > .git/hooks-probe',
      'echo x >> .sdlc/audit/2026-11-23.jsonl',
      'echo x > .claude/new.json',
    ]) {
      expect(sandboxed(command).status, `${command} should fail`).not.toBe(0);
    }
    expect(existsSync(join(root, 'docs', 'new.md'))).toBe(false);
    expect(contents('.sdlc/audit/2026-11-23.jsonl')).toBe(SECRET);
  });

  it('blocks reading protected paths in the project and under the home directory', () => {
    for (const command of [
      'cat .env',
      'cat packages/api/.env.production',
      'cat .sdlc/audit/2026-11-23.jsonl',
      'cat .claude/settings.local.json',
      `cat ${join(home, '.ssh', 'id_rsa')}`,
      // Copying is a read too: the secret must not reach an in-scope file.
      'cp .env src/leak.txt',
    ]) {
      const result = sandboxed(command);
      expect(result.status, `${command} should fail`).not.toBe(0);
      expect(result.output).not.toContain('do-not-leak');
    }
    const leak = join(root, 'src', 'leak.txt');
    expect(existsSync(leak) && readFileSync(leak, 'utf8').includes('do-not-leak')).toBe(false);
  });

  it('negative control: unprotected files stay readable, in or out of scope', () => {
    // Proves the read refusals come from the protected list, not a blanket deny.
    for (const [command, expected] of [
      ['cat docs/existing.md', 'original'],
      ['cat .envrc', 'not a secret'],
      ['cat .claude/settings.json', 'shared settings'],
    ] as const) {
      const result = sandboxed(command);
      expect(result.status, `${command}: ${result.output}`).toBe(0);
      expect(result.output).toContain(expected);
    }
  });

  it('negative control: the blocked writes succeed without the sandbox', () => {
    // Proves the write refusals come from the rules, not from the commands.
    const result = spawnSync('sh', ['-c', 'echo probe > docs/unsandboxed.md'], { cwd: root });
    expect(result.status).toBe(0);
    expect(existsSync(join(root, 'docs', 'unsandboxed.md'))).toBe(true);
  });

  it('documents the known limit: new entries beside the scope can be created', () => {
    // The deny list is built from what exists at launch (see bash-sandbox.ts,
    // "Known limits"). If this ever starts failing, the limit has been closed
    // and the module header and ADR-010 should be updated.
    expect(sandboxed('echo new > NEW_TOP_LEVEL.md').status).toBe(0);
    expect(sandboxed('echo new > src-tauri/notes.txt').status).toBe(0);
  });
});
