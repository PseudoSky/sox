import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    include: ['libs/host-runtime/src/**/*.spec.ts', 'libs/host-runtime/src/**/*.test.ts'],
    environment: 'node',
    root: resolve(__dirname, '../..'),
  },
});
