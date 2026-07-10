import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['extensions/bundles/sox-memory-bundle/members/memory-cli/src/**/*.spec.ts'],
    environment: 'node',
    root: resolve(__dirname, '../../../../..'),
  },
});
