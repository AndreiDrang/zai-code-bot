import { defineConfig } from 'vitest/config';

// Test environment: plain Node.
//
// All Cloudflare bindings (D1, R2, Queue) are exercised through mocked
// objects (see src/tests/*), and `shared/` only uses portable Web APIs
// (Web Crypto subtle, fetch, Response, Headers) that Node 18+ provides
// natively — so no workerd/miniflare runtime is needed for the suite.
// This also drops the deprecated `vitest-environment-miniflare` dependency
// (its miniflare 2 / undici 5 transitive tree carries unpatchable audit
// findings).
const TEST_ENV = 'node';

export default defineConfig({
  test: {
    globals: true,
    environment: TEST_ENV,

    include: ['src/tests/**/*.test.js'],

    coverage: {
      provider: 'v8',
      // 'lcov' feeds the CI Codecov upload (./coverage/lcov.info); keep the
      // human-facing reporters for local runs.
      reporter: ['text', 'json', 'html', 'lcov'],
      // Scope coverage to the unit-testable surface: the shared lib plus the
      // main worker (entrypoint included — index.js is exercised through
      // src/tests/index-fetch.test.js with mocked bindings). The heavy
      // worker's LLM handlers are exercised via mocked integration tests
      // (queue.test.js, handlers-review-llm.test.js), not unit coverage.
      include: ['src/shared/**/*.js', 'src/zai-main-worker/src/**/*.js'],
      exclude: ['src/tests/**', '**/*.d.ts'],
      // Per-glob thresholds: a ratcheting floor (branches included) tracks
      // the test-coverage paydown. Actuals after the coverage paydown:
      // shared ~94.7% branches / ~98% lines, main-worker ~94% branches / ~98%
      // lines. Defensive-only tails (agent/runner, zai-client safe tails) hold
      // the last few branches; raise further only alongside refactors.
      thresholds: {
        'src/shared/**': { lines: 95, functions: 95, branches: 93, statements: 95 },
        'src/zai-main-worker/src/**': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
      },
    },
  },
});
