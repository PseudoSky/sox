import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@sox/tokenguard-core': resolve(__dirname, '../../../libs/tokenguard-core/dist/index.js'),
    },
  },
  test: {
    include: ['extensions/services/tokenguard/test/**/*.spec.ts'],
    environment: 'node',
    root: resolve(__dirname, '../../..'),
  },
});
