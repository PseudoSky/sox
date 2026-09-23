import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    include: [resolve(__dirname, 'src/**/*.spec.ts'), resolve(__dirname, 'src/**/*.test.ts')],
    environment: 'node',
    // Without an explicit testTimeout, vitest 4.x defaults to 5000ms — strictly
    // SMALLER than the 8000ms wait budgets doctor-reconcile.spec.ts's own
    // helpers (waitForFile/waitForPpid, :348/:357) are written against. Under
    // load, a test gets killed at 5000ms before its own waiters have spent
    // their stated 8000ms budget, so the helper timeout is dead code. Match
    // the root vitest.config.ts:67-68 (testTimeout/hookTimeout: 30_000) so
    // this project is no longer the outlier.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
