import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    root: 'libs/data/embed/embedding-provider',
    include: ['src/**/*.{spec,test}.ts'],
  },
});
