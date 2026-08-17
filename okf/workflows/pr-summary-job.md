---
type: Workflow
title: PR-summary job
description: The internal pr_summary job converts a committed V2 snapshot into validated structured JSON (pr-summary.json) used as auxiliary review context — it never posts a GitHub comment.
source_paths:
  - poc/workers/zai-heavy-worker/src/handlers/pr-summary.js
  - poc/workers/shared/llm-context.js
  - poc/workers/shared/pr-context-reader.js
  - poc/workers/shared/storage/deliveries.js
confidence: observed
status: current
tags:
  - workflow
  - context
  - llm
---

# PR-summary job

After a successful [PR-context gather](/workflows/pr-context-pipeline.md)
commits a V2 snapshot, an internal `pr_summary` job asks Z.ai to compress it
into a small structured JSON summary stored in R2 at
`v2/prs/{repo}/{pr}/context/pr-summary.json`. The summary is **auxiliary
context for later `/zai review` runs** — this job deliberately publishes no
GitHub comment.

## Trigger

The gather creates the job via `createPrSummaryJob()` **after** the manifest
is readable: it reuses the originating webhook delivery row (`ownsDelivery:
false`, `action: 'context_ready'`, unique on `(delivery_id, 'pr_summary')`).
It is published immediately through the heavy worker's Queue producer when
available; the D1 [transactional outbox](/contracts/transactional-outbox.md)
remains the recovery path.

## Steps

1. Build a Context Service pinned to the job's head; read snapshot slices
   (including the bounded combined diff reconstructed from per-file patches).
2. **Stale guard** — if the manifest is missing, older, or newer than the
   job's head, return `stale`/`context_stale` without calling the model; a
   post-model re-check discards an answer whose head was superseded while the
   model ran.
3. Call Z.ai (`glm-5.2` default) with the generated `pr-summary.txt` system
   prompt and a fallback user prompt capped at 60 KiB when the primary
   (≤200 KiB, repo-configurable `maxContextBytes`) prompt times out.
4. **Validate the JSON strictly** — `validatePrSummary()` enforces an exact
   shape: `prSummary` (≤1500 chars), `keyChanges[]` (≤20 items, `file` ≤300 /
   `change` ≤500 chars), `conversationSummary { mainTopic | null,
   unresolvedQuestions[] ≤20, resolvedQuestions ≥0 }`. Any deviation is a
   retryable `pr_summary_invalid_json` error.
5. Write the artifact `{ schemaVersion: 1, generatedAt, headSha, model,
   promptVersion: 'pr-summary-v1', summary }`.

## Consumption

`readPrSummary()` returns the artifact only when `schemaVersion === 1`.
[LLM command execution](/workflows/llm-command-execution.md) uses it as
review background **only when its `headSha` matches the current manifest
head**; the reconstructed snapshot diff stays authoritative.

## Relationships

- Produced by the [PR-context gather pipeline](/workflows/pr-context-pipeline.md);
  both follow the [job lifecycle](/state/job-lifecycle.md) and
  [retry budget](/rules/retry-budget.md).
- Reads the V2 snapshot through the [Context Service](/contracts/agent-context-tools.md)
  and stores its result in the R2 context tier ([storage authority model](/architecture/storage-authority-model.md)).
