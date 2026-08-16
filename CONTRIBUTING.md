# Contributing

The maintained application is under `poc/`. The repository no longer contains
the old GitHub Action source or generated bundle.

## Development

```bash
cd poc
npm ci
npm test
```

Run a Worker locally with `npm run dev:main` or `npm run dev:heavy`. Deploy only
after both Wrangler dry-runs succeed.

## Change rules

- Keep only `/zai review` and `/zai describe` in the command allowlist.
- Keep webhook authorization before durable job creation.
- Keep Queue messages limited to `{ schemaVersion, jobId }`.
- Preserve marker idempotency for comments and the `describe` PR-body section.
- Store secrets in Cloudflare Secrets Store, never in source or committed vars.
- Update `README.md` and `poc/README.md` when bindings or workflows change.
