import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    root: 'libs/data/store/store-adapter',
    include: ['src/**/*.spec.ts', 'src/**/__tests__/*.test.ts', 'test/**/*.test.ts'],
    testTimeout: 30000,
  },
});
