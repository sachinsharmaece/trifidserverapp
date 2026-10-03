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
    // Both default to 'false' in production (pivoting away from Enquiry and
    // chain-stage tracking for now, see config/env.ts) — 'true' here so the
    // suite's existing coverage of the enabled behavior keeps running
    // unchanged. Set via `test.env`, not tests/setup.ts: these must land in
    // process.env before config/env.ts's own `export const env = {...}` is
    // first evaluated by any test file's import graph.
    env: {
      ENQUIRY_FLOW_ENABLED: 'true',
      CHAIN_STAGE_TRACKING_ENABLED: 'true',
    },
  },
});
