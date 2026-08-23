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
      // the test-coverage paydown. Actuals after Phase 1: shared ~86%
      // branches / ~97% lines, main-worker ~94% branches / ~99% lines.
      // Ratchet the floor up as tests land: 90 after Phase 3, 93 after Phase 5.
      thresholds: {
        'workers/shared/**': { lines: 70, functions: 70, branches: 85, statements: 70 },
        'workers/zai-main-worker/src/**': {
          lines: 70,
          functions: 70,
          branches: 70,
          statements: 70,
        },
      },
    },
  },
});
