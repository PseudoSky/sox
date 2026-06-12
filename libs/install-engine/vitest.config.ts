import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    include: ['libs/install-engine/src/**/*.spec.ts', 'libs/install-engine/src/**/*.test.ts'],
    environment: 'node',
    root: resolve(__dirname, '../..'),
  },
});
