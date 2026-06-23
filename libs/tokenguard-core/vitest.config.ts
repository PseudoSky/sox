import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@adhd/sox-tokenguard-core': resolve(__dirname, 'dist/index.js'),
    },
  },
  test: {
    include: ['libs/tokenguard-core/test/**/*.spec.ts'],
    environment: 'node',
    root: resolve(__dirname, '../..'),
  },
});
