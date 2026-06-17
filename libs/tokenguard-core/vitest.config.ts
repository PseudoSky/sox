import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@sox/tokenguard-core': resolve(__dirname, 'dist/index.js'),
    },
  },
  test: {
    include: ['libs/tokenguard-core/test/**/*.spec.ts'],
    environment: 'node',
    root: resolve(__dirname, '../..'),
  },
});
