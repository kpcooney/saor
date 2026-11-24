/**
 * agents/src/git/system-git.ts
 *
 * The real-filesystem `ReadTextFile` the branch-state readers use in
 * production. Kept apart from branch-state.ts so that module stays pure.
 */

import { readFileSync } from 'node:fs';

import type { ReadTextFile } from './branch-state.js';

/** Read a file as UTF-8, or `undefined` if it is missing, a directory, or unreadable. */
export const readTextFileOrUndefined: ReadTextFile = (absolutePath) => {
  try {
    return readFileSync(absolutePath, 'utf8');
  } catch {
    // Absent or unreadable both mean "nothing to read here" to the callers.
    return undefined;
  }
};
