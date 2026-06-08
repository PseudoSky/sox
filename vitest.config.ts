import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['extensions/**/*.test.ts', 'scripts/**/*.test.ts'],
    globals: false,
  },
});
