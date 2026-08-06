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
      reporter: ['text', 'json', 'html'],
      // Scope coverage to the pure, unit-testable surface (shared lib + the
      // main worker's router). Worker entry points and the stubbed heavy
      // handlers are exercised by integration tests, not unit tests.
      include: ['workers/shared/**/*.js', 'workers/zai-main-worker/src/router.js'],
      exclude: ['workers/tests/**', '**/*.d.ts'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
});
