import { defineConfig } from 'vitest/config';

// Test environment.
//
// The reference project (tb-bcse-securities-collector) uses `miniflare` for
// Cloudflare Workers runtime fidelity, relying on its root wrangler.toml. The
// POC has no root wrangler.toml (each worker keeps its own), so miniflare is
// configured inline via `environmentOptions`.
//
// If miniflare proves incompatible on this Node version, flip TEST_ENV to
// 'node': Node 18+ natively provides every Web API the shared modules use
// (Web Crypto subtle, fetch, Response, Headers), so the unit tests stay valid.
const TEST_ENV = 'miniflare';

export default defineConfig({
  test: {
    globals: true,
    environment: TEST_ENV,
    environmentOptions:
      TEST_ENV === 'miniflare'
        ? {
            miniflare: {
              compatibilityDate: '2024-09-23',
              modules: true,
              script: 'export default { fetch() { return new Response("ok"); } }',
            },
          }
        : undefined,

    include: ['workers/tests/**/*.test.js'],

    coverage: {
      provider: 'v8',
      // 'lcov' feeds the CI Codecov upload (./coverage/lcov.info); keep the
      // human-facing reporters for local runs.
      reporter: ['text', 'json', 'html', 'lcov'],
      // Scope coverage to the unit-testable surface: the shared lib plus the
      // main worker (entrypoint included — index.js is exercised through
      // workers/tests/index-fetch.test.js with mocked bindings). The heavy
      // worker's LLM handlers are exercised via mocked integration tests
      // (queue.test.js, handlers-review-llm.test.js), not unit coverage.
      include: ['workers/shared/**/*.js', 'workers/zai-main-worker/src/**/*.js'],
      exclude: ['workers/tests/**', '**/*.d.ts'],
      // Per-glob thresholds: a ratcheting floor (branches included) tracks
      // the test-coverage paydown. Actuals after the coverage paydown:
      // shared ~94.7% branches / ~98% lines, main-worker ~94% branches / ~98%
      // lines. Defensive-only tails (agent/runner, zai-client safe tails) hold
      // the last few branches; raise further only alongside refactors.
      thresholds: {
        'workers/shared/**': { lines: 95, functions: 95, branches: 93, statements: 95 },
        'workers/zai-main-worker/src/**': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
      },
    },
  },
});
