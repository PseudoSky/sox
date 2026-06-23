import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// Root is the repo root (4 levels up from this config).
const repoRoot = resolve(__dirname, '../../../../..');

export default defineConfig({
  resolve: {
    alias: {
      // Resolve @adhd/sox-memory-core to the workspace lib dist (same as tsc path alias).
      '@adhd/sox-memory-core': resolve(repoRoot, 'libs/memory-core/dist/index.js'),
    },
  },
  test: {
    include: [resolve(__dirname, 'src/**/*.spec.ts'), resolve(__dirname, 'src/**/*.test.ts')],
    globals: false,
    environment: 'node',
    passWithNoTests: true,
  },
});
