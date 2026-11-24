/**
 * agents/tests/acceptance/tier-conventions.test.ts
 *
 * Guards the acceptance tier's own wiring (ADR-012). Vitest only runs files
 * matching `*.test.ts`, so a definition-of-done file with a slightly wrong
 * name would be skipped without any warning while the tier stayed green. This
 * fails instead, and holds the naming convention that ties each file to its
 * issue.
 */

import { readdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const ISSUE_FILE = /^issue-\d{3}-[a-z0-9-]+\.acceptance\.test\.ts$/;
/** Entries that are part of the tier but are not an issue's tests. */
const NOT_ISSUE_FILES = ['README.md', 'support', 'tier-conventions.test.ts'];

describe('acceptance tier conventions', () => {
  it('names every file in the tier issue-NNN-<capability>.acceptance.test.ts', () => {
    const entries = readdirSync(dirname(fileURLToPath(import.meta.url)));
    const issueFiles = entries.filter((entry) => !NOT_ISSUE_FILES.includes(entry));

    expect(issueFiles.filter((entry) => !ISSUE_FILE.test(entry))).toEqual([]);
    // Negative controls: the listing found the real files, and the pattern
    // rejects the near-misses that vitest would silently skip.
    expect(issueFiles.length).toBeGreaterThanOrEqual(3);
    expect(ISSUE_FILE.test('issue-007-identity-scope.acceptance.ts')).toBe(false);
    expect(ISSUE_FILE.test('issue-7-identity-scope.acceptance.test.ts')).toBe(false);
  });
});
