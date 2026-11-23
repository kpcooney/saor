/**
 * agents/src/sandbox/system-environment.ts
 *
 * The real-machine implementation of the facts the Bash sandbox builder needs:
 * the platform, whether a command is installed, the home directory, and a
 * directory listing. Kept apart from bash-sandbox.ts so that module stays pure
 * and its tests can pass a fabricated environment instead.
 */

import { accessSync, constants, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

import type { BashSandboxEnvironment } from './bash-sandbox.js';

/** Whether an executable named `name` exists in a directory on the PATH. */
function hasCommandOnPath(name: string): boolean {
  const directories = (process.env['PATH'] ?? '').split(delimiter).filter((dir) => dir.length > 0);
  return directories.some((directory) => {
    try {
      accessSync(join(directory, name), constants.X_OK);
      return true;
    } catch {
      // Not in this directory (or not executable); keep looking.
      return false;
    }
  });
}

/** Entry names in a directory, or none if it is missing or unreadable. */
function listDirectoryOrEmpty(absolutePath: string): readonly string[] {
  try {
    return readdirSync(absolutePath);
  } catch {
    // A directory that cannot be listed has no entries to deny individually;
    // the sandbox still blocks writes outside the project as a whole.
    return [];
  }
}

/** A path with its symlinks resolved, or the path itself if that fails. */
function realPathOrSame(absolutePath: string): string {
  try {
    return realpathSync(absolutePath);
  } catch {
    // The path does not exist yet; there is no other spelling to add.
    return absolutePath;
  }
}

/** The environment of the machine this process is running on. */
export function systemBashSandboxEnvironment(): BashSandboxEnvironment {
  return {
    platform: process.platform,
    hasCommand: hasCommandOnPath,
    homeDir: homedir(),
    listDirectory: listDirectoryOrEmpty,
    realPath: realPathOrSame,
  };
}
