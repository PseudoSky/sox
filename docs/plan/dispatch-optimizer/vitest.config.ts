import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    root: 'docs/plan/dispatch-optimizer',
    include: ['src/**/*.{spec,test}.ts'],
  },
});
