# Operations Runbook

## Inspecting the pipeline

The main Worker acknowledges GitHub quickly and publishes a D1 job ID to
`bot-jobs`. The heavy Worker claims the job and either acknowledges success,
retries a transient failure, or records a terminal failure in D1.

Check both Worker logs and the D1 job state before replaying a command. The
main Worker cron recovers expired leases and unpublished outbox rows.

## Common failures

- **401 from GitHub webhook:** verify the GitHub webhook secret and HMAC
  delivery headers.
- **403 on a command:** the commenter is not an authorized collaborator.
- **503 from the main Worker:** verify `BOT_DB`, `BOT_JOBS`, and the GitHub token.
- **No AI result:** verify `ZAI_API_KEY`, `ZAI_MODEL`, Queue delivery, and the
  heavy Worker logs.
- **Duplicate comments:** inspect `comment_publications`; do not manually
  delete the marker unless repairing a known GitHub-side change.

## Recovery

1. Fix the binding or secret.
2. Confirm the affected D1 job is queued or its lease has expired.
3. Let the cron sweep recover it, or issue the command again.
4. Check that the marker-owned comment/PR-body section was updated.
