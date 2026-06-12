import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@sox/manifest': resolve(__dirname, 'libs/manifest/dist/index.js'),
      '@sox/authoring': resolve(__dirname, 'libs/authoring/dist/index.js'),
      '@sox/install-engine': resolve(__dirname, 'libs/install-engine/dist/index.js'),
      '@sox/host-runtime': resolve(__dirname, 'libs/host-runtime/dist/index.js'),
      '@sox/registry': resolve(__dirname, 'libs/registry/dist/index.js'),
      '@sox/memory-core': resolve(__dirname, 'libs/memory-core/dist/index.js'),
    },
  },
  test: {
    include: ['extensions/**/*.test.ts', 'scripts/**/*.test.ts'],
    globals: false,
  },
});
