import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    root: 'libs/data/graph/graph-store',
    include: ['src/**/*.{spec,test}.ts'],
    fileParallelism: false,
    testTimeout: 5000,
  },
});
