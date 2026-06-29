import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    root: 'libs/data/search/hybrid-search',
    include: ['src/**/*.{spec,test}.ts'],
  },
});
