import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const repoRoot = resolve(__dirname, '../../../../..');

export default defineConfig({
  resolve: {
    alias: {
      '@adhd/sox-memory-core': resolve(repoRoot, 'libs/memory-core/dist/index.js'),
      '@adhd/sox-memory-enrich': resolve(repoRoot, 'libs/memory-enrich/dist/index.js'),
      '@adhd/sox-service-proxy': resolve(repoRoot, 'libs/service-proxy/dist/index.js'),
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
