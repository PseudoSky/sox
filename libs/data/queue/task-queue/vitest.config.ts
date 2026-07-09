import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    root: 'libs/data/queue/task-queue',
    include: ['src/**/*.{spec,test}.ts'],
    fileParallelism: false,
    testTimeout: 5000,
  },
});
