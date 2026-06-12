import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    include: ['libs/registry/src/**/*.spec.ts', 'libs/registry/src/**/*.test.ts'],
    environment: 'node',
    root: resolve(__dirname, '../..'),
  },
});
