import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./tests/globalSetup.ts'],
    setupFiles: ['./tests/setup.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
    // All test files share one in-memory replica set — run them one at a
    // time so seeded roles, rate-limit counters and lockouts from one file
    // cannot bleed into another.
    fileParallelism: false,
  },
});
