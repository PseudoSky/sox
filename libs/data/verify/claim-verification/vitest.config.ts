import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    root: 'libs/data/verify/claim-verification',
    globals: true,
    environment: 'node',
    include: ['src/**/*.spec.ts', 'src/**/*.test.ts'],
    testTimeout: 180_000,
  },
});
