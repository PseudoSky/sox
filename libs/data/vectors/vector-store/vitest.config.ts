import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    root: 'libs/data/vectors/vector-store',
    include: ['src/**/*.{spec,test}.ts'],
  },
});
