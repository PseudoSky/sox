import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

const repoRoot = resolve(__dirname, '../../../../..');

export default defineConfig({
  resolve: {
    alias: {
      '@sox/memory-core': resolve(repoRoot, 'libs/memory-core/dist/index.js'),
      '@sox/memory-enrich': resolve(repoRoot, 'libs/memory-enrich/dist/index.js'),
    },
  },
  test: {
    include: [
      'extensions/bundles/sox-memory-bundle/members/memory-server/src/**/*.spec.ts',
      'extensions/bundles/sox-memory-bundle/members/memory-server/src/**/*.test.ts',
      'extensions/bundles/sox-memory-bundle/members/memory-server/*.test.ts',
    ],
    environment: 'node',
    root: repoRoot,
  },
});
