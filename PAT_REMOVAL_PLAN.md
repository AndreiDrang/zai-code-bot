# 🔧 GitHub App Cutover — Fix Plan (Issues 1–5 + Full PAT Removal)

Parent plan: [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md) (GitHub App migration).
This plan fixes review issues **#1–#5** and goes one step further than the parent plan:
**all PAT fallback and PAT logic is removed. GitHub App auth becomes the only auth path.**

---

## 0. Scope

| Review issue                                                             | Resolution in this plan                                                              |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| #1 Failing tests (5) + missing coverage for App-auth paths               | WS6 — rewrite/extend test files                                                      |
| #2 Secrets read without `resolveSecretValue` (silent auth breakage)      | WS1 — provider resolves bindings                                                     |
| #3 Missing **Collaborators: read-only** App permission                   | WS8 — App settings + docs + explicit 403 error                                       |
| #4 Eager token mint on every webhook (PR `synchronize` pays for nothing) | WS4 — lazy client construction                                                       |
| #5 `refreshPrComments` hard-wires PAT; `isAuthorized` is PAT-only        | WS4 / WS3 — App client + delete dead helper                                          |
| ➕ Remove PAT entirely                                                   | WS2, WS4, WS5, WS7 — `Bearer`-only client, no fallback, drop `GITHUB_TOKEN` bindings |

Out of scope (filed separately): migration 0004 dead columns (#8), token cache `expires_at` (#9), docs/OKF updates (#7 — only the parent plan's permission table is touched in WS8), prettier-only churn (#6 — touched files are formatted as part of WS9 hygiene).

### Design decisions locked in by PAT removal

1. **App-only auth.** No code path may construct a `GitHubClient` from `GITHUB_TOKEN`. The `GITHUB_TOKEN` Secrets Store binding is removed from both workers; the store entry `ZAI_GITHUB_TOKEN` is deleted only after rollout is confirmed stable (rollback window).
2. **`GitHubClient` always sends `Authorization: Bearer <token>`.** The `isApp` option is deleted. Every token in the system is an installation token.
3. **Auth unavailability is a hard, _visible_ failure.** No silent fallbacks:
   - Main worker (webhook, synchronous): respond **503** so GitHub retries the delivery; log a specific error code.
   - Heavy worker (queue, durable): classify the failure — transient errors retry, config/permanent errors fail the job with a distinct code (see §WS5 table).
4. **Legacy pre-migration jobs** (`installation_id IS NULL`, created before this deploy) can never authenticate. They fail fast with `missing_installation_id` (≤ 3 attempts → `failed`). Mitigation: deploy during a drained/quiet queue (§WS9).
5. **`resolveBotLogin`'s `GET /user` probe is removed.** Installation tokens cannot call `GET /user` (403). `isBotOwnedComment`'s `type === 'Bot'` check covers all App-posted comments; the optional `GITHUB_BOT_LOGIN` var remains the only way to also match legacy PAT-era help comments (`type 'User'`). Review/describe upserts need no change: `comment_publications.github_comment_id` (exact-id match) already recognizes legacy PAT-posted result comments.
6. **Error surface rule (SECURITY.md):** token mint failures log codes + short messages; raw provider bodies stay out of GitHub comments and out of logs (current `err.body` field on mint errors must not be logged — see WS1).

---

## WS1 — `src/shared/github-app-auth.js` (fixes #2, #10-naming)

### Changes

1. Import and use `resolveSecretValue` from `./secrets.js` for **both** `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY`. This handles the three real-world binding shapes (plain string, `{get()}`, `Promise`) documented in `secrets.js` for this exact store (`629e5dd…`). Raw `env.*` reads are forbidden.
2. `createTokenProvider` becomes **async** (secrets must be awaited) and returns a provider with an explicit availability flag:

```js
import { resolveSecretValue } from './secrets.js';

export async function createTokenProvider(env) {
  const appId = await resolveSecretValue(env.GITHUB_APP_ID);
  const privateKey = await resolveSecretValue(env.GITHUB_APP_PRIVATE_KEY);
  const cache = env.BOT_CACHE ? new AppTokenCache(env.BOT_CACHE) : null;

  return {
    available: Boolean(appId && privateKey),
    async getInstallationToken(installationId) {
      if (!appId || !privateKey) {
        throw appAuthError(
          'app_auth_unconfigured',
          'GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY not configured',
          { retryable: false },
        );
      }
      if (!installationId) {
        throw appAuthError('missing_installation_id', 'webhook/job carries no installation id', {
          retryable: false,
        });
      }
      const cached = cache ? await cache.get(installationId) : null;
      if (cached) return cached;

      const jwt = await generateAppJwt(appId, privateKey);
      const token = await fetchInstallationToken(jwt, installationId);

      if (cache) await cache.set(installationId, token);
      return token;
    },
  };
}
```

1. Rename module-level `getInstallationToken(jwt, installationId)` → **`fetchInstallationToken`** (it clashes with the provider method of the same name/arity-1; WS6 tests updated).
2. Add a small `appAuthError(code, message, { retryable, status })` factory. Map HTTP responses from the token endpoint:

| Mint response / condition         | `code`                    | `retryable` |
| --------------------------------- | ------------------------- | ----------- |
| network error, HTTP 5xx, 429      | `app_token_fetch_failed`  | ✅ true     |
| 401 (bad JWT / wrong key)         | `app_jwt_rejected`        | ❌ false    |
| 403 (app suspended)               | `app_suspended`           | ❌ false    |
| 404 (installation removed)        | `installation_not_found`  | ❌ false    |
| secrets missing                   | `app_auth_unconfigured`   | ❌ false    |
| no installation id on job/webhook | `missing_installation_id` | ❌ false    |

Do **not** attach `err.body` (raw GitHub response) to errors that get logged; keep only status + code (the current code sets `err.body = body` — drop it or mark it non-enumerable). 5. `generateAppJwt` body is unchanged (it is correct). `AppTokenCache` unchanged (5-min KV TTL; `expires_at` handling stays out of scope).

### Acceptance

- Unit tests pass with a **real RSA keypair** (see WS6).
- Provider resolves all three binding shapes; `available === false` when either secret is missing/blank.

---

## WS2 — `src/shared/github.js` (PAT removal in the client)

1. Delete the `isApp` option from the constructor and JSDoc.
2. `Authorization: \`Bearer ${this.token}\`` unconditionally.
3. JSDoc: token param documented as "GitHub App installation access token".

Tests: `src/tests/github.test.js` line 63 flips from `'token mock-token'` to `'Bearer mock-token'`; any `isApp` option tests are removed/replaced by a single Bearer assertion.

---

## WS3 — `src/shared/auth.js` (fixes #5b, PAT-only helper)

1. **Delete `isAuthorized(env, owner, repo, username)`** — it builds a PAT client and has no production callers.
2. `authorizeCommenter` stays, plus one hardening for the App world (#3): map **403** to a clear error instead of propagating an opaque one:

```js
if (error.status === 404) return false; // not a collaborator
if (error.status === 403) {
  // Installation token lacks the "Collaborators: read-only" permission.
  const e = new Error(
    'app_permission_missing: collaborator check requires Collaborators read-only',
  );
  e.code = 'app_permission_missing';
  e.retryable = false;
  throw e;
}
throw error;
```

1. Update header comment (no more "shared PAT" language).

Tests: `src/tests/auth.test.js` — remove the `isAuthorized` describe block; add a 403 → `app_permission_missing` test.

---

## WS4 — `src/zai-main-worker/src/index.js` (fixes #4, #5a, PAT removal)

### 4.1 Lazy client construction (fix #4)

- **Delete** the eager `createGitHubClient(env, installationId, logger)` call at line ~152 (right after payload parsing).
- Keep `const installationId = webhookData.installation?.id;` where it is — it is needed by the PR-context path and comment-refresh path.
- Build the client **only on the command path**, after Gate 4 (`parseCommand` succeeded) and before Gate 5 (authorization):

```js
// --- Gate 4.5: GitHub App client (App-only auth; no PAT fallback) ---
const github = await createAppGitHubClient(env, installationId, logger);
```

- The PR-context path (`pull_request` → `createPrContextJob`) constructs **no** client (it only writes D1 + enqueues). `createCommandDurableJob` reuses the same client for `getPullRequest`. Help/unauthorized/unsupported posts reuse it.
- `createAppGitHubClient` (replaces `createGitHubClient`, drops `isAppAuth` — unused):

```js
async function createAppGitHubClient(env, installationId, logger) {
  const provider = await createTokenProvider(env);
  if (!installationId) {
    logger.error('Webhook carried no installation id; is the webhook source the GitHub App?', {});
    throw Object.assign(new Error('missing_installation_id'), { status: 503 });
  }
  if (!provider.available) {
    logger.error('GitHub App auth unconfigured (GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY)', {});
    throw Object.assign(new Error('app_auth_unconfigured'), { status: 503 });
  }
  const token = await provider.getInstallationToken(installationId);
  logger.info('Using GitHub App authentication', { installationId });
  return new GitHubClient(token);
}
```

- A thrown 503-ish error inside the command path is caught by the existing catch-all → today that returns 500; **change**: let `createAppGitHubClient` errors map to `503` (GitHub redelivers webhooks on 5xx; 500 also triggers redelivery, but 503 is the accurate semantic). Implement by checking `error.status` in the catch-all or by local try/catch around the client creation returning `json(503, …)`/`Response 503`. Keep messages generic to callers (SECURITY.md).
- A failed mint for a _help_ command fails the same way — acceptable (config error should be loud).

### 4.2 `refreshPrComments` on App auth (fix #5a)

```js
async function refreshPrComments(env, plan, installationId, logger) {
  // Best-effort: on App-auth failure we skip the mirror (slice is derivative;
  // the next gather rewrites it wholesale). Never throw into waitUntil.
  try {
    const github = await createAppGitHubClient(env, installationId, logger);
    return await refreshCommentsSlice({ github, bucket: env.BOT_ARTIFACTS, ...plan });
  } catch (error) {
    logger.warn('Comment slice refresh skipped: app auth unavailable', { code: error?.code });
    return null;
  }
}
```

- Call site: `ctx.waitUntil(refreshPrComments(env, plan, installationId, logger).catch(() => {}))`.
- Restore the doc comment that was deleted in the previous commit (explains the throwaway-client rationale) — updated for App auth.

### 4.3 `resolveBotLogin` de-PAT (design decision 5)

```js
/** Optional var matching legacy PAT-era help comments (type 'User'). */
function resolveBotLogin(env) {
  return env?.GITHUB_BOT_LOGIN || null;
}
```

- No API call (installation tokens cannot `GET /user`). `postHelp` signature unchanged (`botLogin` still fed to `isBotOwnedComment`).
- Document the one-time cost: if `GITHUB_BOT_LOGIN` is unset, a legacy PAT help comment is not recognized and a fresh help comment is posted once.

### 4.4 Cleanup in the same file

- Remove the `## ⚠️` escape-sequence churn in `postUnauthorizedComment` (restore literal emoji) and the `postHelp` find() reformat — keep the diff to real changes (review #6 residue in touched hunks).
- No other reference to `GITHUB_TOKEN` / `resolveSecretValue` remains in this file except the webhook secret (Gate 3).

---

## WS5 — `src/zai-heavy-worker/src/queue.js` (PAT removal, error classification)

Replace `createQueueGitHubClient` with a strict version:

```js
async function createQueueGitHubClient(env, job, logger) {
  if (!job.installation_id) {
    // Pre-migration job: can never authenticate post-PAT-removal.
    const e = new Error('missing_installation_id');
    e.retryable = false;
    e.code = 'missing_installation_id';
    throw e;
  }
  const provider = await createTokenProvider(env);
  if (!provider.available) {
    const e = new Error('app_auth_unconfigured');
    e.retryable = false;
    e.code = 'app_auth_unconfigured';
    throw e;
  }
  const token = await provider.getInstallationToken(job.installation_id); // throws classified appAuthError
  logger.info('Using GitHub App authentication for queue job', {
    installationId: job.installation_id,
    jobId: job.job_id,
  });
  return new GitHubClient(token);
}
```

- `fetchInstallationToken` errors already carry `retryable`/`code` (WS1); the existing queue catch block honors `error.retryable !== false` → transient mints (`app_token_fetch_failed`) retry with backoff, permanent ones fail the job (`markJobFailed`) with the cause code in `safeErrorCode(error)` → logs.
- Remove `resolveSecretValue(env.GITHUB_TOKEN)` import usage from this file (the import can go if unused).
- `src/shared/storage/jobs.js`/`deliveries.js` need **no** change: `claimJob` → `getJob` already returns `installation_id` via `JOB_BASE`.

---

## WS6 — Tests (fixes #1; keeps CI + coverage thresholds green)

Thresholds to hold: `src/shared/**` ≥ 95 lines / 93 branches; `src/zai-main-worker/src/**` ≥ 90. New code paths must be covered — the matrix below is the definition of done.

### 6.1 Rewrite `src/tests/github-app-auth.test.js` (4 currently-failing tests)

Root cause of today's failures: the fabricated `TEST_PRIVATE_KEY` is not valid base64 → `atob` throws in `generateAppJwt`. Fix with a **real** keypair (no fixtures):

```js
import { generateKeyPairSync } from 'node:crypto';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const TEST_PRIVATE_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const PUBLIC_KEY_DER = publicKey.export({ type: 'spki', format: 'der' });
```

| Test                     | Assertion                                                                                                                                                                                                                                          |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| JWT structure            | 3 dot-separated base64url parts                                                                                                                                                                                                                    |
| JWT header               | `{ alg: 'RS256', typ: 'JWT' }` after decode                                                                                                                                                                                                        |
| JWT payload              | `iss === appId`, `exp - iat === 540`, `iat` ≈ now                                                                                                                                                                                                  |
| **JWT signature**        | `crypto.subtle.verify('RSASSA-PKCS1-v1_5', importedSpki, sigBytes, data)` is `true`                                                                                                                                                                |
| Key formatting           | PEM with `\r\n`, blank lines, surrounding whitespace still works                                                                                                                                                                                   |
| `fetchInstallationToken` | success (token + URL + headers), 404/401/403/5xx/network error mapping (code + retryable flags per WS1 table)                                                                                                                                      |
| `AppTokenCache`          | keep the 5 existing passing tests                                                                                                                                                                                                                  |
| `createTokenProvider`    | (a) all three secret binding shapes resolve — string, `{get}`, `Promise`; (b) `available === false` when a secret is missing/blank; (c) cache hit → no `fetch`; (d) cache miss → fetch once + `put`; (e) mint error propagates with classification |

### 6.2 `src/tests/index-fetch.test.js`

1. **Fix line 578** — the stale assertion. Add `installation: { id: 456 }` to the `prEventPayload`/`prCommentPayload` fixtures and assert `createPrContextJob` was called with `(env.BOT_DB, event, 456)`.
2. `makeEnv()`: replace `GITHUB_TOKEN: 'gh-token'` with `GITHUB_APP_ID`/`GITHUB_APP_PRIVATE_KEY` (via mocked provider — see 3).
3. `vi.mock('../../shared/github-app-auth.js')` (matching the existing `GitHubClient` mock pattern) with a controllable provider: `{ available: true, getInstallationToken: vi.fn().mockResolvedValue('ghs_test') }`.
4. New tests (App-auth coverage for the main worker):

| Scenario                            | Expectation                                                                                                          |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Command (`/zai review`)             | provider called with `456`; client created; job flow as before                                                       |
| **PR `synchronize`** (fix #4)       | provider **never** called (no token mint), 202 + job created as today                                                |
| Non-command comment / unknown event | provider never called                                                                                                |
| `installation` absent from payload  | 503; no job; error log `missing_installation_id`                                                                     |
| Provider `available: false`         | 503; `app_auth_unconfigured`                                                                                         |
| Mint failure                        | 503 (no 500); no job                                                                                                 |
| Comment-refresh event               | refresh path receives `installationId`; when provider fails, refresh is skipped (warn) and the webhook still 200/202 |
| `GITHUB_BOT_LOGIN` unset            | help flow works with `botLogin === null` (no `GET /user` call)                                                       |

### 6.3 `src/tests/queue.test.js`

- Fixture jobs get `installation_id: 456`; env gets the mocked provider (or `GITHUB_APP_ID`/key strings with `fetchInstallationToken` mocked — follow the file's existing mock style).
- New tests:

| Scenario                             | Expectation                                                                  |
| ------------------------------------ | ---------------------------------------------------------------------------- |
| Happy path                           | handler receives a Bearer client; `markJobSucceeded`; `message.ack()`        |
| `installation_id: null` (legacy job) | `markJobFailed` (no retry), `message.ack()`, cause `missing_installation_id` |
| Provider unavailable                 | fail, `app_auth_unconfigured`                                                |
| Mint 500/network                     | `markJobRetryable` + `message.retry({delaySeconds})`                         |
| Mint 401                             | fail, `app_jwt_rejected`                                                     |

### 6.4 `src/tests/github.test.js`

- `Authorization` header: `'Bearer mock-token'` (replace the `'token mock-token'` assertion at line 63); drop `isApp` cases.

### 6.5 `src/tests/auth.test.js`

- Delete `isAuthorized` block; add `authorizeCommenter` 403 → `app_permission_missing` (non-retryable) test.

---

## WS7 — Configuration cleanup (PAT removal in wrangler)

Both `src/zai-main-worker/wrangler.toml` and `src/zai-heavy-worker/wrangler.toml`:

1. **Delete** the `[[secrets_store_secrets]]` block binding `GITHUB_TOKEN` (`ZAI_GITHUB_TOKEN`).
2. Update the store manifest comments: auth = GitHub App (`GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`) + webhook secret + `ZAI_API_KEY`; drop "PAT for result comments" wording.
3. Keep `BOT_CACHE` (repo-config cache + installation-token cache), `BOT_DB`, `BOT_JOBS`, `BOT_ARTIFACTS` untouched.
4. `GITHUB_BOT_LOGIN` remains an optional `[vars]` (main worker only, already commented there).

> The Secrets Store entry `ZAI_GITHUB_TOKEN` itself is **kept** until WS9 step 6 (rollback window), then deleted.

---

## WS8 — GitHub App permission fix (fixes #3)

1. **GitHub App settings** (org App → Permissions & events → Repository permissions):
   - Add **Collaborators → Read-only** (required by `GET /repos/{owner}/{repo}/collaborators/{user}` with an installation token — the `/zai` authorization gate).
   - Confirm existing set: Contents R, Pull requests RW, Issues RW, Pull request comments RW, Metadata R (auto).
   - Permission changes require users to **accept the new permissions** on existing installations (org settings → GitHub Apps) before they take effect — verify post-change.
2. **`IMPLEMENTATION_PLAN.md`** Task 1.1 permission table: add the Collaborators row with the reason above; adjust Task 2/3 snippets that show PAT fallback (mark them superseded by this plan).
3. **Verification** (staging, after WS6 code is deployed to staging): installation token + `GET /collaborators/{user}` for (a) a collaborator → 204, (b) an outsider → 404, (c) wrong-permission token → 403 with `app_permission_missing` in worker logs.

---

## WS9 — Verification, hygiene, rollout

### 9.1 Local gates (definition of done for the branch)

```bash
npm test                        # all green, coverage thresholds hold
npm run format:js               # prettier --write (touched files)
npx vitest run src/tests/github-app-auth.test.js src/tests/index-fetch.test.js src/tests/queue.test.js
npm run deploy:main:dry-run && npm run deploy:heavy:dry-run
```

### 9.2 Rollout order (production)

| Step | Action                                                                                                                                                                                                                           | Why                                                                                                                       |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 1    | `npx wrangler d1 migrations apply bot-db --remote` (main worker dir; applies 0004)                                                                                                                                               | New code inserts `installation_id` on every job — schema must exist first. Use migrations ledger, not `d1 execute --file` |
| 2    | Confirm GitHub App state (WS8) + webhook: App-owned webhook at `/github/webhook`, same `ZAI_GITHUB_WEBHOOK_KEY` secret, events `issue_comment`, `pull_request`, `pull_request_review_comment`; App installed on target org/repos | Without installation ids every command 503s                                                                               |
| 3    | **Drain/quiet window**: confirm queue depth ≈ 0 (or pause consumer until in-flight pre-migration jobs finish)                                                                                                                    | Legacy `installation_id NULL` jobs will fail with `missing_installation_id` after cutover (bounded ≤ 3 attempts)          |
| 4    | `make deploy` (heavy first, then main — existing order)                                                                                                                                                                          | Consumer ready before producer                                                                                            |
| 5    | Staging checks: `/zai help`, `/zai review`, `/zai describe` as collaborator (comments show `type: Bot`); non-collaborator gets denial comment; PR push produces `pr_context` job                                                 | Acceptance                                                                                                                |
| 6    | After 24–48h stable: delete `ZAI_GITHUB_TOKEN` from Secrets Store (`wrangler secrets:store delete`)                                                                                                                              | Closes the rollback window                                                                                                |

### 9.3 Rollback

Secrets entry is retained (until step 6), so rollback = `git revert` this branch → `make deploy` → re-add the `GITHUB_TOKEN` binding blocks (from this revert). Old code works regardless of whether webhooks arrive via the App or the legacy repo webhook, provided the webhook secret matches.

### 9.4 Acceptance checklist

- [x] `npm test` green; coverage thresholds hold (shared ≥95/93, main ≥90) — 552/552 tests, exit 0
- [x] No occurrence of `GITHUB_TOKEN` in `src/` outside tests' mock envs (grep gate → empty)
- [x] No `token` Authorization scheme anywhere (`grep -rn "token \${" src` → empty)
- [x] PR `synchronize` webhook mints **zero** tokens (test-asserted; plain-issue and ignored-action events too)
- [x] All `appAuthError` codes classified and test-covered
- [ ] Collaborators permission set on the App; staging 204/404 checks pass (manual — WS8.1/8.3)
- [ ] Migration applied before deploy; queue drained at cutover (manual — WS9.2 steps 1–4)
- [ ] `ZAI_GITHUB_TOKEN` deleted after stability window (manual — WS9.2 step 6)

---

## Suggested commit sequence

1. `refactor(auth): app-only token provider with secret resolution + error classification` (WS1–WS3 + their tests)
2. `refactor(main-worker): lazy App-only GitHub client; de-PAT comment refresh & bot login` (WS4 + index-fetch tests)
3. `refactor(heavy-worker): App-only queue auth with retryable/permanent error mapping` (WS5 + queue tests)
4. `chore(config): drop GITHUB_TOKEN bindings; document App-only secrets` (WS7)
5. `docs: add Collaborators permission; mark PAT fallback superseded` (WS8)
