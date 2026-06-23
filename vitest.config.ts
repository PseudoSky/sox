import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@adhd/sox-manifest': resolve(__dirname, 'libs/manifest/dist/index.js'),
      '@adhd/sox-authoring': resolve(__dirname, 'libs/authoring/dist/index.js'),
      '@adhd/sox-install-engine': resolve(__dirname, 'libs/install-engine/dist/index.js'),
      '@adhd/sox-host-runtime': resolve(__dirname, 'libs/host-runtime/dist/index.js'),
      '@adhd/sox-registry': resolve(__dirname, 'libs/registry/dist/index.js'),
      '@adhd/sox-memory-core': resolve(__dirname, 'libs/memory-core/dist/index.js'),
    },
  },
  test: {
    include: ['extensions/**/*.test.ts', 'scripts/**/*.test.ts'],
    globals: false,
  },
});
