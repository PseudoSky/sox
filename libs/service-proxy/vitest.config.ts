import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    include: [resolve(__dirname, 'src/**/*.spec.ts'), resolve(__dirname, 'src/**/*.test.ts')],
    globals: false,
    environment: 'node',
    passWithNoTests: true,
    // The re-dial / restart e2e spins real UDS sockets + child timing; give it room.
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
