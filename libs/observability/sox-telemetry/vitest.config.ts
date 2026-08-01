import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    include: [resolve(__dirname, 'src/**/*.spec.ts'), resolve(__dirname, 'src/**/*.test.ts')],
    globals: false,
    environment: 'node',
    passWithNoTests: false,
    testTimeout: 30_000,
  },
});
