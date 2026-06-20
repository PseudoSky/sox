import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    include: [
      'extensions/bundles/sox-memory-bundle/members/memory-server/src/**/*.spec.ts',
      'extensions/bundles/sox-memory-bundle/members/memory-server/src/**/*.test.ts',
      'extensions/bundles/sox-memory-bundle/members/memory-server/*.test.ts',
    ],
    environment: 'node',
    root: resolve(__dirname, '../../../../..'),
  },
});
