import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    root: 'libs/data/store/blob-store',
    include: ['src/**/*.spec.ts'],
    testTimeout: 30000,
  },
});
