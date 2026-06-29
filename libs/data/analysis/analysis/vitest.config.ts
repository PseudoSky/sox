import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    root: 'libs/data/analysis/analysis',
    include: ['src/**/*.{spec,test}.ts'],
  },
});
