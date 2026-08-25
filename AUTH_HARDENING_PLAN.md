# Auth hardening plan — post-incident fixes from the 2026-08-25 App-auth rollout

Branch: `feature/github-app-auth` (on top of `9251ca3`)
Follows: `PAT_REMOVAL_PLAN.md` (completed, all workstreams checked off)
Status: planned, not started

## Incident summary (evidence base)

The App-auth rollout went live after creating `ZAI_GITHUB_APP_PRIVATE_KEY`, but every
webhook that needed a token mint failed with **HTTP 503** and the log signature:

- `GitHub App token mint failed` with `code: 5` (a **number**)
- one log entry whose label was the bare string `"5"`

Root causes (both confirmed by live validation):

1. **PKCS#1 key format.** GitHub's "Generate a new private key" downloads
   `-----BEGIN RSA PRIVATE KEY-----` (PKCS#1). `generateAppJwt` strips only the
   PKCS#8 header, so `RSA`, `BEGIN`, and dashes survive into the "base64" body and
   `atob()` throws `INVALID_CHARACTER_ERR` — the legacy `DOMException` numeric code
   **5**, which has no resemblance to our string error taxonomy. Fix applied
   operationally: `openssl pkcs8 -topk8 -nocrypt` + `secrets-store secret update`.
   The code still accepts this failure mode silently.
2. **Log envelope collision.** `createLogger` spreads `...data` **after** `message`,
   so any data object carrying a `message` key overwrites the log label. The fetch
   catch-all logs `{ message: error.message, ... }` — with the rethrown
   `new Error(error?.code)` from the mint path that label became `"5"`, destroying
   diagnosability in the dashboard.

Operational state after the incident: store secret `806f5b0c…` now holds a valid
PKCS#8 key; redelivered webhook minted and returned 200. These fixes prevent
recurrence and make the next failure self-explanatory.

## 0. Scope

In scope (three workstreams + verification):

- WS1 — classify malformed GitHub App private keys (`app_key_wrong_format`,
  `app_key_invalid`) before `atob`/`importKey` can throw unclassified errors.
- WS2 — make log envelope keys un-collidable; rename error-detail `message:` data
  keys to `errorMessage:` at logger call sites.
- WS3 — document the failure playbook (RUNBOOK) and the PKCS#8 requirement
  (`.dev.vars.example`, `wrangler.toml` comment).
- WS4 — verification gates and commit sequence.

Out of scope:

- Accepting PKCS#1 keys in code (DER AlgorithmIdentifier wrapping). Rejected: adds
  hand-rolled ASN.1 for a case with a one-command fix; fail-loud with the remedy in
  the error message matches the repo's philosophy better.
- Review-plan issues #6–#14 (unchanged, still deferred).
- okf changes: the bundle has no GitHub App auth concept and no boundary changes
  here; creating one is not warranted by a hardening patch.
- Any secret/binding/`wrangler.toml` structural change (comments only).
- The `503`-on-non-retryable mint failure behavior in the main worker. Intentionally
  kept: GitHub redelivery is the recovery path once the operator fixes the secret —
  that is exactly how today's incident healed.

## WS1 — Malformed-key guard with classified errors

**File:** `src/shared/github-app-auth.js` (guard inside `generateAppJwt`; no export
surface changes)

### Changes

Extract the inline normalization (current lines 65–79) into a module-private
`toPkcs8Der(privateKey)` helper with explicit validation stages, each throwing an
`appAuthError`:

| Stage | Condition                                                                       | Code                   | retryable | Message must say                                                                                        |
| ----- | ------------------------------------------------------------------------------- | ---------------------- | --------- | ------------------------------------------------------------------------------------------------------- |
| 1     | raw key matches `-----BEGIN (RSA\|EC\|DSA\|OPENSSH )PRIVATE KEY-----`           | `app_key_wrong_format` | `false`   | GitHub downloads PKCS#1; convert with `openssl pkcs8 -topk8 -nocrypt -in <pem> -out <pem>` and re-store |
| 2     | after stripping PKCS#8 markers + all whitespace, body matches `[^A-Za-z0-9+/=]` | `app_key_invalid`      | `false`   | secret value is not clean base64 — likely truncated or corrupted; re-store the whole file               |
| 3     | `atob` or `importKey('pkcs8', …)` throws                                        | `app_key_invalid`      | `false`   | decodes but is not a PKCS#8 RSA key — wrong file or double-encoded                                      |

Rules:

- Messages reference format/remedy only — never key bytes (SECURITY.md).
- No `status` on these errors (not HTTP failures).
- `generateAppJwt` keeps its signature; the helper replaces the inline strip logic
  and returns the `Uint8Array` DER bytes.
- `createTokenProvider` unchanged — `available` stays a presence check; format
  problems surface loudly at mint time (consistent with existing design).

### Propagation (why no other file changes)

- Main worker: `createAppGitHubClient` catch already logs `{ code, retryable }` and
  503s — the code now reads `app_key_wrong_format` instead of `5`, and the
  fetch catch-all rethrows `new Error(error.code)` producing message
  `app_key_wrong_format` instead of `5`.
- Heavy worker queue: `retryable: false` → permanent fail without burning retries.

### Tests (`src/tests/github-app-auth.test.js`, `describe('generateAppJwt')`)

Additive; fixtures need no real crypto (detection precedes parsing):

1. PKCS#1 header (RSA) wrapping the existing `TEST_PRIVATE_KEY` body → rejects with
   `code: 'app_key_wrong_format'`, `retryable: false`, message matches `/pkcs8 -topk8/`.
2. `EC` variant header → same code (regex covers the family).
3. PKCS#8 headers around `not!valid!base64!!` → `app_key_invalid`, non-retryable.
4. PKCS#8 headers around `btoa('definitely not a der key')` → `app_key_invalid`
   (stage 3, via importKey).
5. Existing CRLF/whitespace tolerance test must stay green (stage ordering:
   header check on raw string tolerates CRLF; charset check only after strip).

In `describe('createTokenProvider')`: one test — configured provider with a PKCS#1
key rejects at `getInstallationToken` with the classified shape (not a raw
`DOMException`).

## WS2 — Log envelope collision fix

**Files:** `src/shared/logging.js` + 5 call sites.

### Root cause and fix

`logEntry = { timestamp, level, context, env, message, ...data }` — data wins.
Change to envelope-wins:

```js
const logEntry = {
  ...data,
  timestamp,
  level,
  context,
  env,
  message,
};
```

JSDoc: document `timestamp|level|context|env|message` as reserved; note that a
data key colliding with a reserved key is silently overridden — use `errorMessage`
/ `errorCode` for error detail (queue.js already established the `errorCode`
convention).

### Call-site renames (`message:` → `errorMessage:` in logger data)

| File:line                                             | Label                                                                  |
| ----------------------------------------------------- | ---------------------------------------------------------------------- |
| `src/zai-main-worker/src/index.js:221`                | `PR job enqueue failed`                                                |
| `src/zai-main-worker/src/index.js:~311`               | `Durable command job failed`                                           |
| `src/zai-main-worker/src/index.js:~323`               | `Error processing request` (fetch catch-all — the `"5"` incident line) |
| `src/zai-heavy-worker/src/handlers/describe.js:201`   | `Failed to persist describe result`                                    |
| `src/zai-heavy-worker/src/handlers/pr-context.js:258` | `PR summary enqueue deferred to outbox replay`                         |

**Not** renamed: `src/shared/agent/runner.js:383` — that `{ code, message }` object
is an agent-protocol tool-error payload, not logger data.

### Tests (`src/tests/logging.test.js`)

1. `data keys cannot overwrite envelope keys`: `logger.info('label', { message: 'x', level: 'FAKE' })`
   → parsed `message === 'label'`, `level === 'INFO'`.
2. `ordinary data keys spread through`: `{ foo: 'bar' }` present in the entry.
3. Grep gate: `grep -rn "message: error" src --include='*.js' | grep -v /tests/`
   returns only the runner.js protocol payload (or nothing).

## WS3 — Runbook and configuration documentation

### `RUNBOOK.md`

Under **Common failures**, add a `GitHub App token mint failures` table mapping
every `code` to its remedy:

| code                      | retryable | remedy                                                                                                                                                    |
| ------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app_key_wrong_format`    | no        | key is PKCS#1 (GitHub's download format) → `openssl pkcs8 -topk8 -nocrypt -in k.pem -out k8.pem`, then update store secret, then redeliver failed webhook |
| `app_key_invalid`         | no        | re-download the key from the App settings page, re-store the whole file via stdin pipe                                                                    |
| `app_jwt_rejected`        | no        | App ID wrong, or key regenerated in GitHub after storing — re-store the current key                                                                       |
| `app_suspended`           | no        | unsuspend the App (repo/org settings)                                                                                                                     |
| `installation_not_found`  | no        | installation removed or App changed — reinstall                                                                                                           |
| `app_auth_unconfigured`   | no        | `ZAI_GITHUB_APP_ID` / `ZAI_GITHUB_APP_PRIVATE_KEY` missing from store `629e5dd…`                                                                          |
| `missing_installation_id` | no        | webhook source is not the App — check the webhook configuration                                                                                           |
| `app_permission_missing`  | no        | add Collaborators: Read-only (authorization gate)                                                                                                         |
| `app_token_fetch_failed`  | yes       | transient — GitHub redelivery / queue retry handles it                                                                                                    |

Under **Recovery**, add the validated key-rotation runbook (the exact sequence run
on 2026-08-25): convert → verify locally against the repo's own `generateAppJwt` +
real mint → `npx wrangler secrets-store secret update <store-id> --secret-id <id> --remote`
(run from repo root so the pinned wrangler is used; stdin pipe, never `--value`) →
redeliver the failed delivery (App settings → Advanced, or
`POST /app/hook/deliveries/{id}/attempts` with an App JWT; note the id exceeds
JS safe integers — pass it as a string). Include the KV note: only successful mints
are cached (`installation_token:<id>`, TTL 5 min), so rotation needs no cache purge.

### `.dev.vars.example` (both workers)

Extend the `GITHUB_APP_PRIVATE_KEY` comment: must be **PKCS#8**
(`-----BEGIN PRIVATE KEY-----`); GitHub downloads PKCS#1 — convert with the
openssl one-liner before use.

### `src/zai-main-worker/wrangler.toml` + heavy equivalent

Comment only: append `(PKCS#8)` to the `GITHUB_APP_PRIVATE_KEY` mapping comment.

## WS4 — Verification and commits

### Gates (definition of done)

```bash
npx prettier --check .        # or repo-equivalent
npm test                      # all green, coverage thresholds hold
npx vitest run --coverage     # shared ≥95 lines / ≥93 branches unchanged
grep -rn "message: error" src --include='*.js' | grep -v /tests/   # only runner.js protocol payload
lens_diagnostics mode=all     # zero blocking errors
```

Deploy dry-runs unchanged (comments/docs only — no config delta), run cheaply
anyway as regression cover.

### Commit sequence

1. `fix(auth): classify malformed GitHub App private keys before token mint`
   — `github-app-auth.js` + tests
2. `fix(logging): stop error-detail keys from overwriting log labels`
   — `logging.js` + 5 call sites + tests
3. `docs(runbook): GitHub App auth failure playbook and PKCS#8 key notes`
   — RUNBOOK, `.dev.vars.example` ×2, wrangler.toml comments

### Rollout notes

- No secret, binding, migration, or queue-schema change; deploys are ordinary
  Workers Builds on push.
- Post-deploy check: staging `/zai help` still 200s; optional redelivery of a
  known-good webhook.
- If GitHub ever ships a PKCS#8 key directly, nothing changes — the guard only
  tightens failure modes.
