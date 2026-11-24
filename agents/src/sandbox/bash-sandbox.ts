/**
 * agents/src/sandbox/bash-sandbox.ts
 *
 * Builds the OS-level sandbox configuration for an agent's `Bash` tool (issue
 * #56, ADR-010).
 *
 * The scope-enforcement hook can check a `Write` or `Edit` call because the
 * target path is a parameter. It cannot do that for `Bash`: a shell command can
 * write a file in more ways than any parser will catch. So Bash is confined by
 * the operating system instead — the Claude Agent SDK runs every command inside
 * a sandbox (Seatbelt on macOS, bubblewrap on Linux) configured from the
 * settings built here.
 *
 * What the sandbox enforces, given those settings:
 *
 *   - **Writes outside the project are blocked.** The SDK's sandbox allows
 *     writes only under the working directory (the project root) and a
 *     scratch temp directory.
 *   - **Writes to existing out-of-scope paths inside the project are blocked.**
 *     The SDK always allows the working directory, and restricts within it by
 *     deny list only. So this module walks the project tree at launch and
 *     denies every entry that is not on the way to, or inside, a writable root
 *     (see {@link computeDeniedWritePaths}).
 *   - **Protected paths cannot be read**: other services' credentials under the
 *     home directory, and the project's own secrets and `.sdlc/` state.
 *   - **No network**, because no domains are allowed.
 *   - **No opting out**: `allowUnsandboxedCommands` is off, so the model's
 *     per-command sandbox-escape parameter is ignored.
 *
 * Commits (issue #58, ADR-011). `.git` is outside every agent's file scope, so
 * by default Bash cannot write it and the agent cannot commit. When the caller
 * passes {@link BashSandboxInput.git} — which it does only if the checked-out
 * branch is in the agent's branch scope — `.git` becomes writable *except* for
 * the files that would let a command leave or alter that branch:
 *
 *   - `HEAD` — so the checked-out branch cannot be switched;
 *   - every other branch's ref, and `packed-refs` — so no other branch can be
 *     moved or deleted;
 *   - `refs/tags` and `refs/remotes` — so tags and remote-tracking refs stay
 *     as they are;
 *   - `config` and `hooks` — so a command cannot plant code that runs later
 *     outside the sandbox.
 *
 * That leaves exactly what a commit needs: the object store, the index, the
 * reflogs, and the current branch's own ref. Verified against git directly
 * under the macOS sandbox: `git commit` succeeds, while `git checkout`,
 * `git symbolic-ref HEAD`, `git update-ref` and `git branch -f` on another
 * branch all fail.
 *
 * Known limits — stated here so the code does not claim more than it enforces:
 *
 *   - **New top-level entries.** Because the deny list is built from what
 *     exists at launch, a command can still *create* a new file or directory
 *     directly in the project root, or directly in a directory that is only an
 *     ancestor of a writable root (e.g. a new `src-tauri/notes.txt` when only
 *     `src-tauri/src/**` is in scope). It cannot modify or delete anything that
 *     already existed out of scope, and cannot create anything inside an
 *     existing out-of-scope directory.
 *   - **Directory granularity.** A scope glob is reduced to its literal
 *     directory prefix: `agents/src/**\/*.ts` makes all of `agents/src`
 *     writable to Bash. The hook still applies the exact glob to `Write` and
 *     `Edit`.
 *   - **Reads are a deny list.** Outside the protected paths, a Bash command
 *     can read whatever the user account can. That includes the environment
 *     the agent process was started with, which this module does not filter.
 *   - **The object store is shared.** An agent allowed to commit can write
 *     `.git/objects`, which every branch's history lives in. It cannot move
 *     another branch, but a destructive command could damage the local
 *     repository as a whole. The remote is unaffected: there is no network.
 *   - **Branches created during the run.** The per-branch ref rules are built
 *     at launch from the branches that exist then.
 *   - **A refused branch switch can leave files changed.** `git checkout` of
 *     another branch rewrites in-scope files before it fails on `HEAD`. The
 *     branch does not change; the working tree may need `git checkout -- .`.
 *
 * See docs/adr/010-bash-and-read-confinement.md for why this shape was chosen
 * over dropping Bash or parsing commands.
 */

import { posix as posixPath } from 'node:path';

import type { SandboxSettings } from '@anthropic-ai/claude-agent-sdk';

import type { BashGitAccess } from './git-access.js';
import {
  CLAUDE_HOME_DIR,
  CLAUDE_HOME_READABLE,
  PROTECTED_HOME_PATHS,
  PROTECTED_PROJECT_GLOBS,
} from './protected-paths.js';

/**
 * Directories Bash may write to in addition to the agent's file scope, because
 * running a build or a test suite writes there. These hold generated output,
 * not source: an agent that can run `cargo test` or `npm test` needs them, and
 * nothing reviewed lives in them.
 */
export const BASH_BUILD_OUTPUT_DIRS: readonly string[] = [
  'node_modules',
  'dist',
  'build',
  '.svelte-kit',
  'agents/node_modules',
  'agents/dist',
  'src-tauri/target',
  'src-tauri/gen',
];

/** Everything {@link buildBashSandboxSettings} needs to know about a launch. */
export interface BashSandboxInput {
  /** Absolute path of the project root — the agent's working directory. */
  readonly projectRoot: string;
  /**
   * The project root with symlinks resolved, when that differs from
   * `projectRoot`. The OS matches sandbox rules against real paths, so a rule
   * written only against a symlinked path (macOS's `/var` and `/tmp`, a
   * symlinked checkout) would not apply. When given, every project rule is
   * emitted for both spellings.
   */
  readonly realProjectRoot?: string;
  /** The agent's file-scope globs (`AgentScope.files`), project-relative. */
  readonly writableGlobs: readonly string[];
  /** Extra project-relative directories Bash may write. */
  readonly buildOutputDirs: readonly string[];
  /**
   * Present only when the agent may commit: makes `.git` writable apart from
   * the files that would let a command leave or alter the committable branch.
   * See `resolveBashGitAccess` in ./git-access.ts for when that is.
   */
  readonly git?: BashGitAccess;
  /** Absolute path of the user's home directory. */
  readonly homeDir: string;
  /**
   * Lists the entry names in a directory, given its absolute path. Returns an
   * empty list for a directory that does not exist or cannot be read.
   */
  readonly listDirectory: (absolutePath: string) => readonly string[];
}

/** The platform facts that decide whether Bash can be sandboxed. */
export interface BashSandboxPlatform {
  /** `process.platform`. */
  readonly platform: string;
  /** Whether an executable of this name is on the PATH. */
  readonly hasCommand: (name: string) => boolean;
}

/**
 * Everything about the host machine that sandboxing Bash depends on. Injected
 * so the Code Agent wiring is testable; the real one is
 * `systemBashSandboxEnvironment` in ./system-environment.ts.
 */
export interface BashSandboxEnvironment extends BashSandboxPlatform {
  /** Absolute path of the user's home directory. */
  readonly homeDir: string;
  /** Lists a directory's entry names; empty if it is missing or unreadable. */
  readonly listDirectory: (absolutePath: string) => readonly string[];
  /** Resolves symlinks in a path; returns it unchanged if it cannot. */
  readonly realPath: (absolutePath: string) => string;
  /** Reads a file as text, or `undefined` if it is missing or unreadable. */
  readonly readTextFile: (absolutePath: string) => string | undefined;
}

const GLOB_CHARACTERS = /[*?[\]{}]/;

/** The repository directory, relative to the project root. */
const GIT_DIR = '.git';

/**
 * Paths inside `.git` that stay unwritable even for an agent allowed to
 * commit, whatever branches exist. See the module header for why each is here.
 */
const GIT_ALWAYS_DENIED: readonly string[] = [
  'HEAD',
  'packed-refs',
  'config',
  'hooks',
  'refs/tags',
  'refs/remotes',
];

/**
 * The project-relative paths inside `.git` that Bash must not write when the
 * agent is allowed to commit: the fixed set, plus every other branch's ref.
 */
export function gitDeniedWritePaths(git: BashGitAccess): string[] {
  return [
    ...GIT_ALWAYS_DENIED,
    ...git.otherBranches.map((branch) => `refs/heads/${branch}`),
  ].map((path) => `${GIT_DIR}/${path}`);
}

/**
 * Whether the OS sandbox the SDK relies on is present. macOS ships Seatbelt;
 * Linux needs `bwrap` (bubblewrap) and `socat` installed; nothing else is
 * supported.
 *
 * This matters because the SDK does not fail when asked to sandbox on a
 * platform that cannot: it runs the command unsandboxed. Callers must check
 * this and withhold Bash when it is false.
 */
export function isBashSandboxAvailable(environment: BashSandboxPlatform): boolean {
  if (environment.platform === 'darwin') {
    return true;
  }
  if (environment.platform === 'linux') {
    return environment.hasCommand('bwrap') && environment.hasCommand('socat');
  }
  return false;
}

/**
 * Reduce a file-scope glob to the directory (or file) Bash is allowed to write:
 * the path segments before the first one containing a glob character. A glob
 * with no literal prefix (`**\/*.ts`) yields `''`, meaning the whole project.
 */
export function writableRootOfGlob(glob: string): string {
  const segments = glob.replace(/\\/g, '/').split('/');
  const literal: string[] = [];
  for (const segment of segments) {
    if (GLOB_CHARACTERS.test(segment)) {
      break;
    }
    literal.push(segment);
  }
  const root = posixPath.normalize(literal.join('/'));
  return root === '.' ? '' : root.replace(/\/$/, '');
}

function isSameOrInside(path: string, root: string): boolean {
  return root === '' || path === root || path.startsWith(`${root}/`);
}

/**
 * Walk the project tree and return the project-relative paths Bash must not
 * write: every existing entry that is neither inside a writable root nor an
 * ancestor of one. Ancestors are descended into, so only the out-of-scope
 * siblings along the way are denied.
 *
 * For roots `src` and `src-tauri/src` in a project containing `docs/`,
 * `src/`, `README.md`, and `src-tauri/{src,Cargo.toml}`, the result is
 * `['README.md', 'docs', 'src-tauri/Cargo.toml']`.
 */
export function computeDeniedWritePaths(
  projectRoot: string,
  writableRoots: readonly string[],
  listDirectory: (absolutePath: string) => readonly string[],
): string[] {
  const denied: string[] = [];

  function visit(relativeDir: string): void {
    const absoluteDir = relativeDir === '' ? projectRoot : posixPath.join(projectRoot, relativeDir);
    const entries = [...listDirectory(absoluteDir)].sort();
    for (const entry of entries) {
      const relativePath = relativeDir === '' ? entry : `${relativeDir}/${entry}`;
      if (writableRoots.some((root) => isSameOrInside(relativePath, root))) {
        continue;
      }
      const leadsToWritableRoot = writableRoots.some((root) =>
        root.startsWith(`${relativePath}/`),
      );
      if (leadsToWritableRoot) {
        visit(relativePath);
      } else {
        denied.push(relativePath);
      }
    }
  }

  visit('');
  return denied;
}

/**
 * Express an absolute path the way the SDK's sandbox settings expect: a leading
 * `//` marks a path from the filesystem root. (A single leading `/` would be
 * read as relative to the settings location.)
 */
function sandboxAbsolutePath(absolutePath: string): string {
  return `/${absolutePath}`;
}

/**
 * The home-relative paths inside the Claude CLI's state directory that Bash
 * must not read: every entry that exists there except the few the CLI needs
 * sandboxed commands to reach. Listed entry by entry because the sandbox's read
 * rules are a deny list — there is no way to say "all of this directory but".
 */
export function protectedClaudeHomePaths(
  homeDir: string,
  listDirectory: (absolutePath: string) => readonly string[],
): string[] {
  return [...listDirectory(posixPath.join(homeDir, CLAUDE_HOME_DIR))]
    .filter((entry) => !CLAUDE_HOME_READABLE.includes(entry))
    .sort()
    .map((entry) => `${CLAUDE_HOME_DIR}/${entry}`);
}

/**
 * Build the sandbox settings for an agent's Bash tool. Pure apart from the
 * injected `listDirectory`, so the result is fully determined by the input.
 */
export function buildBashSandboxSettings(input: BashSandboxInput): SandboxSettings {
  const normalizeRoot = (root: string): string => root.replace(/\\/g, '/').replace(/\/$/, '');
  const projectRoot = normalizeRoot(input.projectRoot);
  // Both spellings of the root, deduplicated: see `realProjectRoot`.
  const projectRoots = [
    ...new Set([projectRoot, normalizeRoot(input.realProjectRoot ?? input.projectRoot)]),
  ];
  const underEachRoot = (relativePath: string): string[] =>
    projectRoots.map((root) => sandboxAbsolutePath(posixPath.join(root, relativePath)));

  const writableRoots = [
    ...input.writableGlobs.map(writableRootOfGlob),
    ...input.buildOutputDirs,
    ...(input.git !== undefined ? [GIT_DIR] : []),
  ];

  const denyWrite = [
    ...computeDeniedWritePaths(projectRoot, writableRoots, input.listDirectory),
    ...(input.git !== undefined ? gitDeniedWritePaths(input.git) : []),
  ].flatMap(underEachRoot);

  const homeDir = input.homeDir.replace(/\\/g, '/');
  const denyRead = [
    ...[...PROTECTED_HOME_PATHS, ...protectedClaudeHomePaths(homeDir, input.listDirectory)].map(
      (path) => sandboxAbsolutePath(posixPath.join(homeDir, path)),
    ),
    ...PROTECTED_PROJECT_GLOBS.flatMap(underEachRoot),
  ];

  return {
    enabled: true,
    // Ignore the model's per-command request to run outside the sandbox.
    allowUnsandboxedCommands: false,
    filesystem: { denyWrite, denyRead },
    // No allowed domains: commands the agent runs have no network access.
    network: { allowedDomains: [] },
  };
}
