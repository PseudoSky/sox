import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@adhd/sox-tokenguard-core': resolve(__dirname, '../../../libs/tokenguard-core/dist/index.js'),
    },
  },
  test: {
    include: ['extensions/services/tokenguard/test/**/*.spec.ts'],
    environment: 'node',
    root: resolve(__dirname, '../../..'),
  },
});
