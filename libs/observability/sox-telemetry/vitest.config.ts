import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    include: [resolve(__dirname, 'src/**/*.spec.ts'), resolve(__dirname, 'src/**/*.test.ts')],
    // 03be90c3: hermetic-telemetry sandbox — redirects SOX_ECOSYSTEM_HOME at a
    // per-file temp root so this package's specs can never write real telemetry
    // into ~/.adhd/sox-ecosystem.
    setupFiles: [resolve(__dirname, 'vitest.setup.ts')],
    globals: false,
    environment: 'node',
    passWithNoTests: false,
    testTimeout: 30_000,
  },
});
