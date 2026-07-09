import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    root: 'libs/source-provider',
    globals: true,
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    testTimeout: 30000,
  },
});
