/**
 * agents/vitest.config.ts
 *
 * Splits the agent layer's tests into two vitest projects so each tier can be
 * run on its own (ADR-007, ADR-012):
 *
 *   - `unit`       — everything under tests/ except the acceptance tier.
 *   - `acceptance` — tests/acceptance/: one file per GitHub issue, the
 *                    executable definition of done for that issue. Real stores
 *                    only, each test paired with a negative control.
 *
 * `npm test` runs both; `npm run test:unit` and `npm run test:acceptance`
 * select one. See tests/acceptance/README.md for the tier's conventions.
 */

import { defineConfig } from 'vitest/config';

const ACCEPTANCE_TESTS = 'tests/acceptance/**/*.test.ts';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['tests/**/*.test.ts'],
          exclude: [ACCEPTANCE_TESTS],
        },
      },
      {
        test: {
          name: 'acceptance',
          include: [ACCEPTANCE_TESTS],
        },
      },
    ],
  },
});
