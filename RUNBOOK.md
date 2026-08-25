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
- **503 from the main Worker:** verify `BOT_DB` and `BOT_JOBS`; a 503 on
  comment-bearing webhooks is usually a GitHub App token mint failure — see
  the table below.
- **No AI result:** verify `ZAI_API_KEY`, `ZAI_MODEL`, Queue delivery, and the
  heavy Worker logs.
- **Duplicate comments:** inspect `comment_publications`; do not manually
  delete the marker unless repairing a known GitHub-side change.

### GitHub App token mint failures

Mint failures log `GitHub App token mint failed` with a classified `code`.
Every code except `app_token_fetch_failed` is non-retryable: the main Worker
answers 503 so GitHub redelivers the webhook once the secret is fixed, and the
heavy Worker fails the job without burning retries.

| code                      | retryable | remedy                                                                                                                                                                     |
| ------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app_key_wrong_format`    | no        | Key is PKCS#1 (GitHub's download format) — convert with `openssl pkcs8 -topk8 -nocrypt -in k.pem -out k8.pem`, update the store secret, then redeliver the failed webhook. |
| `app_key_invalid`         | no        | Stored secret is truncated, corrupted, or the wrong file — re-store the whole PKCS#8 PEM via stdin pipe.                                                                   |
| `app_jwt_rejected`        | no        | App ID is wrong, or the key was regenerated in GitHub after storing — re-store the current key.                                                                            |
| `app_suspended`           | no        | Unsuspend the App (repo/org settings).                                                                                                                                     |
| `installation_not_found`  | no        | Installation removed or App changed — reinstall the App.                                                                                                                   |
| `app_auth_unconfigured`   | no        | `ZAI_GITHUB_APP_ID` / `ZAI_GITHUB_APP_PRIVATE_KEY` missing from the Secrets Store — create both.                                                                           |
| `missing_installation_id` | no        | Webhook source is not the GitHub App — check the webhook configuration.                                                                                                    |
| `app_permission_missing`  | no        | Add Collaborators: Read-only to the App (authorization gate).                                                                                                              |
| `app_token_fetch_failed`  | yes       | Transient — GitHub redelivery / queue retry handles it.                                                                                                                    |

## Recovery

1. Fix the binding or secret.
2. Confirm the affected D1 job is queued or its lease has expired.
3. Let the cron sweep recover it, or issue the command again.
4. Check that the marker-owned comment/PR-body section was updated.

### GitHub App private-key rotation

Validated sequence (2026-08-25 incident):

1. Download the key from the GitHub App settings page. GitHub ships **PKCS#1**
   (`-----BEGIN RSA PRIVATE KEY-----`); the Worker requires **PKCS#8**.
2. Convert and verify:
   `openssl pkcs8 -topk8 -nocrypt -in key.pem -out key-pkcs8.pem` then
   `openssl rsa -in key-pkcs8.pem -check -noout`.
3. Update the secret from the repo root (pinned wrangler; stdin pipe, never
   `--value` — it leaks to shell history):
   `cat key-pkcs8.pem | npx wrangler secrets-store secret update <store-id> --secret-id <secret-id> --remote`
4. Redeliver a failed delivery: App settings → Advanced → Recent deliveries,
   or `POST /app/hook/deliveries/{id}/attempts` with an App JWT. Note: the
   delivery id exceeds JavaScript's safe-integer range — treat it as a string,
   never through `JSON.parse` number coercion.
5. No cache purge needed: only successful mints are cached
   (`installation_token:<id>`, 5-minute TTL), so a previously failing key
   leaves nothing stale behind.
