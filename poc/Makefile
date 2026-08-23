SHELL := /bin/sh

# Worker directories
WORKER_MAIN  := workers/zai-main-worker
WORKER_HEAVY := workers/zai-heavy-worker

.PHONY: help dependencies test test-watch refactor-js format-check deploy-dry-run deploy dev-main dev-heavy tail-main tail-heavy clean

help:
	@printf '%s\n' \
		'make dependencies    Install Node.js dev dependencies (prettier, vitest, etc.)' \
		'make test            Run the Vitest suite with v8 coverage, then print per-column averages' \
		'make test-watch      Run Vitest in watch mode (re-runs on file change)' \
		'make refactor-js     Install ALL deps, then auto-format worker JavaScript' \
		'make format-check    Check JS formatting without writing (CI-style)' \
		'make deploy-dry-run  Bundle + validate both Workers locally (no API calls). Order: heavy, then main' \
		'make deploy          Publish both Workers to Cloudflare. Heavy first so the main binding resolves' \
		'make dev-main        Run the main worker dev server (wrangler dev)' \
		'make dev-heavy       Run the heavy worker dev server (wrangler dev)' \
		'make tail-main       Tail live logs for the main worker' \
		'make tail-heavy      Tail live logs for the heavy worker' \
		'make clean           Remove node_modules and wrangler local state'

# Install Node.js dev dependencies (prettier for formatting; wrangler is used from PATH).
dependencies:
	@npm install

# Run the Vitest unit-test suite with coverage (globals + miniflare env),
# then print the average value for each coverage column (% Stmts / % Branch /
# % Funcs / % Lines) from the istanbul JSON the suite emits — overall and per
# threshold glob, mirroring vitest.config.js.
test:
	@npm test
	@node scripts/coverage-averages.js

# Run Vitest in watch mode (re-runs on file change).
test-watch:
	@npm run test:watch

# Mirror of tbel/Makefile refactor-js: install ALL dependencies, then format JS.
refactor-js: dependencies
	@npm run format:js

# Check formatting without writing.
format-check: dependencies
	@npm run format:js:check

# Validate both Workers locally via wrangler --dry-run (bundles + checks config,
# makes NO API calls, needs no Cloudflare auth).
deploy-dry-run:
	@cd $(WORKER_HEAVY) && wrangler deploy --dry-run
	@cd $(WORKER_MAIN)  && wrangler deploy --dry-run

# Publish both Workers. Deploy the heavy consumer first so Queue consumption is
# ready before the main worker starts publishing jobs.
deploy:
	@cd $(WORKER_HEAVY) && wrangler deploy
	@cd $(WORKER_MAIN)  && wrangler deploy

dev-main:
	@cd $(WORKER_MAIN) && wrangler dev

dev-heavy:
	@cd $(WORKER_HEAVY) && wrangler dev

tail-main:
	@cd $(WORKER_MAIN) && wrangler tail

tail-heavy:
	@cd $(WORKER_HEAVY) && wrangler tail

clean:
	@rm -rf node_modules workers/zai-main-worker/.wrangler workers/zai-heavy-worker/.wrangler
