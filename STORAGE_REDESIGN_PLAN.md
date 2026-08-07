# Storage Tier Redesign — Plan

> **Status:** planned (Phase A ready to implement; Phase B blueprint).
> **Scope:** `poc/workers/*` (Cloudflare Workers PoC).
> **Branch:** `cloudflare-migration`.
> **Created:** 2026-08-07.

---

## 1. Context & problem

Two architectural issues were identified in the current PoC:

### 1.1 R2 stored the bot's *output*, not the task's *context*

`zai-heavy-worker/src/handlers/pr-preview.js` wrote the rendered comment markdown
to R2 as `v1/runs/{jobId}/{runId}/result.md`. Problems:

- It duplicates what already lives on GitHub (the published comment) + the pointer
  in D1 (`comment_publications.github_comment_id`).
- It cannot be linked back to the work that produced it (which files, which diff,
  which prompt). The artifact is disconnected from the task.
- For metadata-only preview there is nothing to store — all data is already columns
  in `pull_requests`. The `result.md` write was pure noise.

**Decision:** R2 = the task's **context** (changed files, diff, commits, PR
description, PR comments), hard-linked to the PR via deterministic keys. Not the
final comment body.

### 1.2 KV was 100 % write-only (no reads existed)

Verified: there is **no** `.get()` from `BOT_CACHE` anywhere in `poc/workers`.
Even the repository-config cache is *write-through without a read* —
`getRepositoryConfig` always queries D1, then writes a copy to KV that nothing
ever reads. KV today is dead weight.

**Decision:** KV = a *read-through* cache of small, hot PR/repo parameters. Drop
the write-only body cache; make the config cache actually read.

### 1.3 D1 is correct as-is

History (`webhook_deliveries`, `jobs`, `comment_publications`, `analysis_runs`,
`artifacts`) is the source of truth and stays. The only later addition is one
migration to register a new job kind (Phase B).

---

## 2. Agreed tier model

| Tier | Binding | Role | In Phase A | In Phase B |
| --- | --- | --- | --- | --- |
| **KV** | `BOT_CACHE` | Read-through cache: small, hot, PR/repo params (derivative; outage = degradation, not failure) | `repo-config` (live) | + `pr-card` |
| **R2** | `BOT_ARTIFACTS` | Task context per PR (blobs), deterministic keys | 0 prod writes (preview cleaned) | `v1/prs/{repo}/{pr}/{head}/context/*` (lifecycle) + `v1/runs/{job}/{run}/response.json` (`artifacts` table) |
| **D1** | `BOT_DB` | Source of truth + history | unchanged | migration 0004 (kind `pr_context`) |

### Principles

- **KV** = small/hot/derivative; versioned or TTL; always falls through to D1.
- **R2 context** keys are **deterministic** from `(repository_id, pr_number,
  head_sha, kind)` → **no new D1 index table**; PR↔R2 linking is trivial in both
  directions (the key embeds the identity); retention via an **R2 bucket
  lifecycle rule**.
- **R2 run-outputs** (LLM `response.json`) stay keyed by `(job_id, run_id)` and
  indexed by the existing `artifacts` table (run↔artifact audit) — a different
  grain from context.
- **Anti-write-only rule:** no writer ships without a reader in the same
  commit-set. (This is exactly what Phase A removes and what gates Phase B.)

---

## 3. PHASE A — «remove dead writes + make config cache read-through»

Executable now, self-contained, leaves **zero write-only KV/R2 code**.

### A1. `zai-heavy-worker/src/handlers/pr-preview.js` — remove all R2/KV work

**Open path (`handlePrPreviewJob`)** — delete:

- `import { artifactExpiresAt, writeArtifact } from '../../../shared/storage/artifacts.js'`
- `import { linkRunResultArtifact } from '../../../shared/storage/jobs.js'`
- `import { prPreviewCacheKey, runArtifactKey } from '../../../shared/storage/keys.js'` (remove entirely — both unused after cleanup)
- the `const resultArtifact = await writeArtifact({ ... })` block
- `await linkRunResultArtifact(db, runId, resultArtifact.artifactId)`
- `bodyArtifactId: resultArtifact.artifactId` from the `upsertComment` call (defaults to `null`; column is nullable)
- the `if (env.BOT_CACHE?.put) { env.BOT_CACHE.put(prPreviewCacheKey(...), body, { expirationTtl: 3600 }) }` block
- `artifactKey: runArtifactKey(...)` from the `return`

**Closed path (`publishClosedComment`)** — same deletions (`writeArtifact`,
`linkRunResultArtifact`, `bodyArtifactId`, `artifactKey`).

**Remains:** config gate → closed branch → supersede `getPullRequest` →
`renderPrPreview` / `renderPrClosed` → `upsertComment`. Clean, no R2/KV.

### A2. `shared/storage/config.js` — make the cache actually read (read-through)

`repoConfigCacheKey` drops the `version` (without it a read cannot know the version
upfront):

```js
// keys.js
export function repoConfigCacheKey(repositoryId) {
  return `v${STORAGE_SCHEMA_VERSION}:repo-config:${component(repositoryId, 'repository id')}`;
}
```

`getRepositoryConfig` — KV first, on miss D1 + write-through (TTL 300s):

```js
const key = repoConfigCacheKey(repositoryId);
if (cache?.get) {
  try {
    const hit = await cache.get(key, { type: 'json' });
    if (hit) return hit;
  } catch {
    /* KV is derivative — fall through to D1 */
  }
}
// ...existing D1 SELECT + fromRow...
if (cache?.put) {
  try { await cache.put(key, JSON.stringify(config), { expirationTtl: 300 }); } catch { /* best effort */ }
}
return config;
```

`saveRepositoryConfig`: `cache.delete(repoConfigCacheKey(repositoryId))` (no `version`).

> Tradeoff: ≤300 s staleness on a missed delete — acceptable for rarely-changed config.

### A3. `shared/storage/keys.js` — drop unused builders

- Remove `prPreviewCacheKey`, `jobStatusCacheKey` (write-only scaffolding).
- `repoConfigCacheKey` — as above (drop `version`).
- Keep: `deliveryArtifactKey`, `runArtifactKey`, `component` validator, constants
  (`STORAGE_SCHEMA_VERSION`, `PR_PREVIEW_JOB_KIND`, `SUPPORTED_JOB_KINDS`).

### A4. Tests — flip assertions + add read-through

**`tests/storage.test.js`**

- Drop imports of `jobStatusCacheKey`, `prPreviewCacheKey`.
- Key-contract test: `repoConfigCacheKey(10)` → `'v1:repo-config:10'`; remove the
  pr-preview / job-status lines.
- "Unsafe component" test: repoint to `runArtifactKey('1/2', 'run', 'result', 'md')`
  → throws `storage key component`.

**`tests/pr-preview-sync.test.js`**

- Remove `vi.mock('../shared/storage/artifacts.js')`,
  `vi.mock('../shared/storage/jobs.js')`, `import { writeArtifact }`,
  `writeArtifact.mockResolvedValue(...)` and all `expect(writeArtifact)...`.
- Drop any `bodyArtifactId` assertion.
- `env.BOT_CACHE` / `env.BOT_ARTIFACTS` become unused (may keep or trim).
- **Keep the core:** "create once on opened" + "UPDATE on synchronize"
  (`upsertComment` mock `created:true` → `created:false`) — that behavior is preserved.

**`tests/pr-preview-closed.test.js`**

- Remove artifacts/jobs mocks and `import { writeArtifact }`.
- Flip: instead of `writeArtifact.toHaveBeenCalledOnce()` + body-from-`writeArtifact`
  → `expect(writeArtifact).not.toHaveBeenCalled()`; assert body via
  `upsertComment.mock.calls[0][0].body` (contains `🔒 PR Closed`,
  `PR closed by @AndreiDrang`, `PR_CLOSED_MARKER`); `bodyArtifactId` not passed
  (`not.objectContaining({ bodyArtifactId: expect.anything() })`).
- "disabled" test: keep `upsertComment).not.toHaveBeenCalled()` +
  `getPullRequest).not.toHaveBeenCalled()`; drop writeArtifact lines.

**NEW `tests/config-cache.test.js`** (the headline new test of Phase A)

- **hit:** `cache.get` returns an object → `getRepositoryConfig` returns it,
  `db.prepare` **not called**.
- **miss:** `cache.get` → null → `db.prepare(...).get()` returns a row →
  `cache.put` called with `repoConfigCacheKey(repoId)` + JSON → parsed config returned.
- **default:** no D1 row → returns `DEFAULT_REPOSITORY_CONFIG`, cached.
- **outage:** `cache.get` throws → falls through to D1 without throwing.

### A5. What is removed (old logic)

- KV body cache `v1:pr-preview:*` (write-only).
- R2 `result.md` artifact from preview/closed + the `linkRunResultArtifact` call
  from those paths.
- `prPreviewCacheKey`, `jobStatusCacheKey`.
- `writeArtifact`/`readArtifact` stay in the module (covered by
  `storage-runtime.test.js`; consumed again by Phase B), but have **0 prod callers**
  after Phase A.

### A6. Validation

`npm test` (expect ~154 → ~150: −2 key assertions + writeArtifact tests, +~4
config-cache) · `prettier --check` · 0 LSP diagnostics.

### A7. Commit

```
refactor(workers): drop write-only kv/r2 from preview and make config cache read-through
```

(source + tests as one atomic commit)

---

## 4. PHASE B — «PR task context» (ships **with** review/impact consumers)

> Blueprint. Each part below ships in the **same commit-set as its reader**, so a
> writer is never without a reader.

### B1. `keys.js` — context/card builders (deterministic)

```js
export const PR_CONTEXT_KINDS = ['manifest', 'diff', 'files', 'commits', 'description', 'comments'];
export function prCardKey(repositoryId, prNumber, headSha) { /* v1:pr-card:{repo}:{pr}:{head} */ }
export function prContextKey(repositoryId, prNumber, headSha, kind) {
  /* v1/prs/{repo}/{pr}/{head}/context/{kind}.{ext-by-kind} */
}
```

### B2. `github.js` — context readers

Verify `getPrFiles` exists; add the missing ones via the existing `request()` with
a `maxContextBytes` budget:

- `getPrDiff` (Accept: `application/vnd.github.v3.diff`)
- `getPrCommits` (paginate `/pulls/{n}/commits`)
- `getPrComments` (`/issues/{n}/comments` + `/pulls/{n}/comments`)
- `getPrDescription` (from `getPullRequest.body`)

### B3. D1 — migration `0004_pr_context_kind.sql`

Only schema change in Phase B: register the `pr_context` job kind (the `jobs.kind`
CHECK currently allows `('pr_preview', 'review', 'impact')`). **No `pr_contexts`
table** — keys are deterministic.

### B4. Enqueuer — enqueue `pr_context` on a new headSha

`job-enqueuer.js`: alongside `createPrPreviewJob`, enqueue a `pr_context` job.
Idempotency is already provided by `delivery_id UNIQUE`.

### B5. Heavy handler `pr-context.js` (new) — gather

- Idempotency: `env.BOT_ARTIFACTS.head(prContextKey(..., 'manifest'))` → if it
  exists for this headSha, skip (redelivery).
- Otherwise: `getPullRequest` + `getPrFiles` + `getPrDiff` + `getPrCommits` +
  `getPrComments` → `R2.put` under deterministic keys (B1) → `KV.put prCardKey`
  (shape + `contextReady: true`).
- No LLM, no comment.

### B6. R2 lifecycle (`wrangler.toml`, both workers)

Rule: delete objects under prefix `v1/prs/` older than `R2_RETENTION_DAYS` (30),
via `wrangler r2 bucket lifecycle` (or the S3-compatible API). `v1/runs/` stays on
the D1-index sweep (run-outputs).

### B7. Consumers (ship **with** B5)

- `review` / `impact`: read context from R2 (`prContextKey`) instead of re-fetching;
  write their own output as `v1/runs/{job}/{run}/response.json` via `writeArtifact`
  (the existing `artifacts` table + `linkRunResultArtifact`).
- `ask` / `explain` (main): read `prCardKey` from KV → PR shape without `getPullRequest`.

### B8. Phase B tests

`pr-context.test.js` (gather: correct keys/shape, skip when manifest exists,
budget enforced), key-contract tests for the new builders, `review`/`impact`
reading from an R2 mock.

---

## 5. Data flow (after both phases)

```
new headSha (opened/synchronize/ready_for_review/edited)
  └─ main → enqueue pr_context (eager) + pr_preview
       ├─ gather (pr-context.js): getPullRequest + changedFiles + diff + commits + comments
       │     ├─ R2.put  v1/prs/{repo}/{pr}/{head}/context/*   (deterministic keys)
       │     └─ KV.put  v1:pr-card:{repo}:{pr}:{head}          (shape + contextReady=true)
       └─ preview/closed (metadata-only) → KV-card / job row → comment. R2 untouched.
review/impact → R2.get context (no re-fetch) → LLM → R2.put response.json (artifacts) → comment.
ask/explain   → KV.get pr-card → shape without getPullRequest.
```

---

## 6. Decisions log

- **R2 = context, not output** — diffs/commits/messages are blobs; R2 is the blob
  tier. Output (comment) lives on GitHub + D1 publication record.
- **No `pr_contexts` table** — context keys are deterministic from
  `(repo, pr, headSha, kind)`; PR↔R2 is computable in both directions; retention is
  an R2 lifecycle rule, not a D1 sweep.
- **Two R2 grains:** context (PR-deterministic, reused across commands, lifecycle)
  vs run-outputs (job/run-specific, `artifacts`-indexed, D1 sweep).
- **`repo-config` key drops `version`** — enables read-through; staleness bounded
  by TTL (300 s) + delete-on-save.
- **Anti-write-only rule** — Phase A deletes all current write-only code; Phase B
  ships every writer with its reader.

---

## 7. Open items / out of scope

- Phase B depends on the `review`/`impact` handlers existing (consumers). It is
  intentionally **not** started in isolation to avoid re-introducing write-only code.
- "merged" vs "closed" wording, and per-file review analysis, remain future work
  beyond this plan.
