import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    root: 'libs/data/ingest/ingest',
    include: ['src/**/*.{spec,test}.ts'],
  },
});
