# LLM Pipeline — deferred logic & implementation spec

> **Status:** not started. This document captures the LLM-dependent logic that
> was intentionally deferred during the storage-tier work (Phases A+B) and the
> scope-1 "context-aware readers" decision. The foundation it needs is now in
> place; this is the build order to make the five heavy `/zai` commands real.
> **Scope:** `poc/workers/*`.

---

## 1. Why it was deferred

The storage redesign shipped in two steps:

- **Phase A** — removed write-only R2/KV from the preview and made the
  repo-config cache read-through.
- **Phase B (scope 1)** — added the eager PR-context gather tier (R2 context +
  KV pr-card) and made `review`/`impact`/`ask`/`explain` read that context as
  **context-aware stubs**.

The **LLM calls themselves** were deferred because (a) the PoC had no Z.ai
client at all, and (b) shipping a writer without its reader would re-introduce
the exact write-only anti-pattern the redesign removed. So the gather (writer)
shipped with the read-helpers (readers), but the LLM call that *consumes* the
gathered context into a `response.json` is the remaining piece.

The net effect: **the LLM work is now much smaller** — the context it needs is
pre-gathered, the run-output storage tier is built and waiting, and the heavy
handlers already resolve the PR shape from the KV card.

---

## 2. What is already in place (the foundation)

| Capability | Where | State |
| --- | --- | --- |
| Eager PR-context gather | `zai-heavy-worker/src/handlers/pr-context.js` | ✅ writes R2 context + KV card per head |
| Context read-helpers | `shared/pr-context-reader.js` (`readPrCard`, `readContextManifest`, `renderContextSummary`, `renderPrCardShape`) | ✅ wired into the 4 context-aware stubs |
| GitHub context readers | `shared/github.js` (`getPrDiff`, `getPrFiles`, `getPrCommits`, `getPrComments`, `getPrDescription`) | ✅ |
| Run-output R2 writer | `shared/storage/artifacts.js` (`writeArtifact`) | ✅ built, **0 prod callers** — this is its first use |
| Run→artifact link | `shared/storage/jobs.js` (`linkRunResultArtifact`) | ✅ built, 0 prod callers |
| Per-attempt run record | D1 `analysis_runs` (`model`, `prompt_version`, `result_artifact_id`, `error_code`) | ✅ schema ready |
| Repo config | `shared/storage/config.js` (`maxContextBytes`, `maxFiles` budgets) | ✅ KV read-through |
| `ZAI_API_KEY` secret | both `wrangler.toml` (`[[secrets_store_secrets]]`) | ✅ bound, **unused** |
| `ZAI_MODEL` var | both `wrangler.toml` `[vars]` (`glm-5.2`) | ✅ set, unused |
| Handler dispatch (command path) | `zai-heavy-worker/src/index.js` `runHeavy({ github, env, payload })` | ✅ handlers get `env` |

Nothing here needs to be built for the LLM work — only consumed.

---

## 3. The Z.ai client (port from the parent bot)

The parent GitHub Action ships a hardened Node client at **`src/lib/api.js`**.
It is CommonJS and uses Node's `https` module, so it must be **ported to the
Workers runtime** (ESM + `fetch`), not copied verbatim.

Port these (signature preserved, transport rewritten):

| Parent export | Purpose | Workers adaptation |
| --- | --- | --- |
| `createApiClient(config)` | factory: timeout / maxRetries / baseDelay / fallbackPrompt | keep; returns `{ call, withFallback, config }` |
| `callWithRetry(fn, opts)` | exponential backoff + progressive timeout + optional fallback prompt | logic is runtime-agnostic — copy as-is |
| `categorizeError(err)` | classify as `auth`/`validation`/`provider`/`rate-limit`/`timeout`/`internal` + `retryable` | keep; read status from `response.status` instead of regex on the message |
| `sanitizeErrorMessage(err)` | strip Bearer tokens / api keys / credentialed URLs before logging or surfacing | keep verbatim (prevents secret leakage) |

**Transport rewrite** — replace `makeApiRequest`'s `https.request` with `fetch`
- an `AbortSignal.timeout(ms)`:

```js
// poc/workers/shared/zai-client.js  (new)
const ZAI_API_URL = 'https://api.z.ai/api/coding/paas/v4/chat/completions';

async function complete({ apiKey, model, messages, timeoutMs }) {
  const res = await fetch(ZAI_API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, messages }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  // categorizeError reads res.status directly (no regex on the message)
  if (!res.ok) {
    const err = new Error(`Z.ai API error ${res.status}`);
    err.status = res.status;            // categorizeError uses this
    err.body = await res.text();
    throw err;
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('Z.ai API returned an empty response');
  return content;
}
```

Parent constants to preserve: `DEFAULT_TIMEOUT_MS = 30000`,
`DEFAULT_MAX_RETRIES = 3`, `DEFAULT_BASE_DELAY_MS = 2000`,
`PROGRESSIVE_TIMEOUT_MULTIPLIERS = [1.0, 0.67, 0.5, 0.33]` (floor 10s).

> The parent client hardcodes a code-review **system message** inside
> `makeApiRequest`. In the port, `messages` is passed in by the caller so each
> handler owns its own prompt — see §4.

**Secret resolution:** the Workers Secrets Store binding can surface as a
string, `{get()}`, or a Promise. Always resolve via
`resolveSecretValue(env.ZAI_API_KEY)` (`shared/secrets.js`) before passing it
to the client — same rule as `GITHUB_TOKEN`.

---

## 4. Per-handler LLM logic

All five handlers are **context-aware stubs** today (`{ github, env, payload }`,
generic `COMMENT_MARKER`, `postComment` placeholder). Each becomes real by:
resolve context → build a bounded prompt → `zaiClient.call(...)` → render →
publish.

### 4.1 `/zai review` (heavy, context-consuming)

- **Input context:** `readPrCard(env.BOT_CACHE, repoId, prNumber)` → head, then
  `readContextManifest(env.BOT_ARTIFACTS, repoId, prNumber, headSha)`. If the
  manifest is missing, fall back to a live `getPullRequest` (the gather may not
  have run yet).
- **Prompt:** the R2 context objects (`diff`, `files`, `commits`, `comments`,
  `description`) assembled under the `maxContextBytes` budget — **never pass an
  unbounded patch** (repo-wide invariant from `AGENTS.md`). Truncate the diff
  slice that the gather already capped.
- **Output:** a markdown review (sections: summary / findings / nits), posted
  via `upsertComment` with marker **`REVIEW_MARKER`** (`<!-- zai-review -->`),
  `commentKind: 'review'`.
- **Persistence:** write the raw LLM response as `response.json` via
  `writeArtifact({ bucket: env.BOT_ARTIFACTS, db, jobId, runId, kind: 'response',
  content })`, then `linkRunResultArtifact(db, runId, artifactId)`.

### 4.2 `/zai impact` (heavy, context-consuming)

- Mirrors review but with a **risk-analysis** prompt and `IMPACT_MARKER`
  (`commentKind: 'impact'`).
- **Extra:** best-effort label application (`github` needs an
  `addLabels(owner, repo, issueNumber, labels)` method on `GitHubClient` —
  currently absent; add `POST /repos/{o}/{r}/issues/{n}/labels`).
- Same `response.json` + `linkRunResultArtifact` persistence.

### 4.3 `/zai ask` (heavy, free-form Q)

- **Input:** the comment body (`payload.comment.body`) is the question;
  `readPrCard` gives the PR shape for context.
- **Prompt:** question + a bounded PR-shape preamble (title/head/file-count).
- **Output:** threaded answer via `upsertComment` (marker `COMMENT_MARKER`,
  `commentKind: 'ask'`). No `response.json` (ask is conversational; optional).

### 4.4 `/zai explain` (heavy, line range)

- **Input:** a line-range / code-anchor from the comment (needs a parser; the
  parent bot has `src/lib/code-scope.js` with `extractWindow` /
  `extractEnclosingBlock` — port the anchor extraction).
- **Prompt:** the target lines + surrounding window.
- **Output:** explanation comment, threaded.

### 4.5 `/zai describe` (heavy, commits → description)

- The **only** heavy handler that is still a plain stub (not context-aware):
  `describe.js` ignores `env`/context. It should fetch PR commits
  (`getPrCommits`) and generate a PR description. No R2 context needed (commits
  are the input), so it can stay independent of the gather.

---

## 5. The run-output tier (anti-write-only completion)

`writeArtifact` / `linkRunResultArtifact` have had **zero prod callers** since
Phase A. The first LLM handler to write `response.json` is what satisfies the
anti-write-only rule for that tier — it writes the artifact **and** reads it
back implicitly via the `analysis_runs.result_artifact_id` audit link. Ship the
writer with at least one consumer (the run-history / retry path), or keep it
minimal: the artifact is the auditable LLM output; D1 `analysis_runs` is the
index.

Run-output keys are `v1/runs/{job}/{run}/response.json` (via `runArtifactKey`),
indexed by the `artifacts` table, swept by the D1-backed retention cron —
**distinct grain** from the gather's `v1/prs/` context (see
[storage authority model](../okf/architecture/storage-authority-model.md)).

---

## 6. Marker & publication migration

Today all five stubs post via plain `github.postComment` with `COMMENT_MARKER`.
When a handler becomes real:

1. Switch to `upsertComment` (D1 publication lease, idempotent one-live-comment
   per `(repo, pr, kind)`).
2. Use the dedicated marker — `REVIEW_MARKER` / `IMPACT_MARKER` (already in
   `shared/constants.js`); add `ASK_MARKER` / `EXPLAIN_MARKER` / `DESCRIBE_MARKER`
   if one-live semantics are wanted (otherwise keep `COMMENT_MARKER` for the
   conversational ones).
3. Set `commentKind` to match `comment_publications` grain.

---

## 7. Wiring & config

- **Secret:** `env.ZAI_API_KEY` (resolve via `resolveSecretValue`).
- **Model:** `env.ZAI_MODEL` (default `glm-5.2`).
- **Timeout/retry:** from `DEFAULT_CONFIG` (`shared/constants.js`:
  `zaiModel`, `timeout: 30000`, `maxRetries: 3`) or per-repo `repository_configs`
  if extended.
- **Budget:** `getRepositoryConfig(...)` already returns `maxContextBytes` /
  `maxFiles` — use them to bound prompt size.
- **Logging:** the categorized client errors map to `createLogger` error codes
  (`zai_rate_limited`, `zai_provider`, `zai_auth`, …) — keep the
  no-raw-exception-internals rule (PR comments never leak `error.message`;
  `sanitizeErrorMessage` handles it).

---

## 8. Build order (recommended)

1. **`shared/zai-client.js`** — port the client (`fetch`-based `complete`,
   `callWithRetry`, `categorizeError`, `sanitizeErrorMessage`). Unit-test with a
   `fetch` mock (mirror `tests/github.test.js`).
2. **One end-to-end handler** — `/zai review`: read context → prompt → Z.ai →
   `response.json` (writeArtifact) → `upsertComment(REVIEW_MARKER)`. This is the
   smallest change that lights up the client **and** the run-output tier
   together (anti-write-only).
3. **`/zai impact`** + the `addLabels` GitHub method.
4. **`/zai ask` / `/zai explain`** (port `code-scope.js` for explain).
5. **`/zai describe`** (commits-based, independent of gather).
6. Update `okf/` (a new `workflows/llm-review-pipeline.md` + refresh the
   handler concept stubs) and `poc/README.md` roadmap once each lands.

---

## 9. Open decisions (resolve before implementing)

- **Prompt content & output format** for each handler (review section layout,
  severity taxonomy, impact risk levels). Not specified anywhere yet.
- **Token / size limits** per Z.ai model vs `maxContextBytes` — confirm the
  gather's byte budget maps to the model's context window.
- **Impact labels** — which labels, and whether application is gated by repo
  config.
- **Fallback prompts** — the parent client supports a compact fallback prompt
  on timeout; decide per-handler whether to use `withFallback`.
- **`ask`/`explain` persistence** — keep conversational (no artifact) or record
  for audit.

---

## 10. Out of scope (explicitly not deferred — just future)

- `.zai-scheduled.yml` regeneration flows (separate roadmap item).
- Auto-review on `pull_request` (the parent bot's `runLargePrReview` batching) —
  a different trigger than the command handlers above.
