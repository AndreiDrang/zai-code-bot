/**
 * Versioned key builders shared by the D1, R2, and KV storage adapters.
 */

export const STORAGE_SCHEMA_VERSION = 1;
export const PR_CONTEXT_JOB_KIND = 'pr_context';
export const PR_SUMMARY_JOB_KIND = 'pr_summary';
export const SUPPORTED_JOB_KINDS = [PR_CONTEXT_JOB_KIND, PR_SUMMARY_JOB_KIND, 'review', 'describe'];

/**
 * R2 context kinds gathered per PR. Each maps to a deterministic object under
 * `v1/prs/{repo}/{pr}/context/{kind}.{ext}` (keyed per PR, not per head). The
 * `manifest` is the idempotency marker (written last) + the index consumers
 * read first; manifest.headSha records which head the snapshot describes.
 */
export const PR_CONTEXT_KINDS = Object.freeze([
  'manifest',
  'files',
  'diff',
  'commits',
  'description',
  'comments',
]);
const CONTEXT_KIND_EXTENSION = {
  manifest: 'json',
  files: 'json',
  diff: 'diff',
  commits: 'json',
  description: 'md',
  comments: 'json',
};

/**
 * V2 keeps the same living per-PR snapshot semantics as V1, but stores a
 * patch per changed file rather than one aggregate diff blob. This is
 * deliberately separate from STORAGE_SCHEMA_VERSION: deliveries, runs, and KV
 * cache keys do not participate in this storage-contract migration.
 */
export const PR_CONTEXT_STORAGE_VERSION = 2;
export const PR_CONTEXT_V2_KINDS = Object.freeze([
  'manifest',
  'files',
  'commits',
  'description',
  'comments',
]);
const CONTEXT_V2_KIND_EXTENSION = {
  manifest: 'json',
  files: 'json',
  commits: 'json',
  description: 'md',
  comments: 'json',
};

const SAFE_COMPONENT = /^[a-zA-Z0-9._-]+$/;

function component(value, name) {
  const text = String(value ?? '');
  if (!text || !SAFE_COMPONENT.test(text)) {
    throw new TypeError(`Invalid ${name} storage key component`);
  }
  return text;
}

export function deliveryArtifactKey(deliveryId, date = new Date()) {
  const day = date.toISOString().slice(0, 10);
  return `v${STORAGE_SCHEMA_VERSION}/deliveries/${day}/${component(deliveryId, 'delivery id')}/payload.json`;
}

export function runArtifactKey(jobId, runId, kind, extension = 'json') {
  return `v${STORAGE_SCHEMA_VERSION}/runs/${component(jobId, 'job id')}/${component(runId, 'run id')}/${component(kind, 'artifact kind')}.${component(extension, 'extension')}`;
}

export function repoConfigCacheKey(repositoryId) {
  return `v${STORAGE_SCHEMA_VERSION}:repo-config:${component(repositoryId, 'repository id')}`;
}

/**
 * KV key for the PR "card" — a small, hot snapshot of the PR's shape
 * (head SHA, title, author, counts, context-ready flag). Keyed by
 * (repositoryId, prNumber) ONLY — not headSha — so command handlers can read
 * the latest card without first calling getPullRequest (the card stores the
 * head it describes). Refreshed on every gather; bounded by TTL.
 */
export function prCardKey(repositoryId, prNumber) {
  return `v${STORAGE_SCHEMA_VERSION}:pr-card:${component(repositoryId, 'repository id')}:${component(prNumber, 'pr number')}`;
}

/**
 * R2 key for one gathered context object, keyed per PR
 * (repositoryId, prNumber, kind) — NOT per headSha. The PR's context is a
 * living snapshot: each new head overwrites it (skip-same-head / overwrite-newer
 * is handled by the gather). Which head the context describes lives INSIDE the
 * manifest (manifest.headSha), mirroring the per-PR pr-card pattern. Retention
 * is an R2 lifecycle rule on the `v1/prs/` prefix (see wrangler.toml).
 */
export function prContextKey(repositoryId, prNumber, kind) {
  if (!PR_CONTEXT_KINDS.includes(kind)) {
    throw new TypeError(`Invalid PR context kind: ${kind}`);
  }
  return `v${STORAGE_SCHEMA_VERSION}/prs/${component(repositoryId, 'repository id')}/${component(prNumber, 'pr number')}/context/${kind}.${CONTEXT_KIND_EXTENSION[kind]}`;
}

/**
 * R2 key for a V2 PR context artifact. V2 is scoped to the PR-context storage
 * contract; other storage keys remain on STORAGE_SCHEMA_VERSION.
 */
export function prContextV2Key(repositoryId, prNumber, kind) {
  if (!PR_CONTEXT_V2_KINDS.includes(kind)) {
    throw new TypeError(`Invalid V2 PR context kind: ${kind}`);
  }
  return `v${PR_CONTEXT_STORAGE_VERSION}/prs/${component(repositoryId, 'repository id')}/${component(prNumber, 'pr number')}/context/${kind}.${CONTEXT_V2_KIND_EXTENSION[kind]}`;
}

/**
 * Returns a canonical repository-relative path. Never concatenate untrusted
 * paths into an R2 key: Context Service first resolves exact paths from the
 * files index, and this helper supplies a second defensive boundary.
 */
export function normalizeRepositoryPath(path) {
  const value = String(path ?? '');
  if (!value || value.startsWith('/') || value.includes('\0')) {
    throw new TypeError('Invalid repository-relative path');
  }
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw new TypeError('Invalid repository-relative path');
  }
  return value;
}

/**
 * A URL-encoded full path is one R2 path component, so nested, Unicode, and
 * punctuation-containing repository paths cannot alter the key hierarchy.
 * The readable canonical path remains in files.json.
 */
export function prContextV2DiffKey(repositoryId, prNumber, path) {
  const safePath = normalizeRepositoryPath(path);
  return `v${PR_CONTEXT_STORAGE_VERSION}/prs/${component(repositoryId, 'repository id')}/${component(prNumber, 'pr number')}/context/diffs/${encodeURIComponent(safePath)}.patch`;
}

/**
 * R2 key for a COMMAND RESULT — the LLM output of one /zai command for one PR,
 * stored under the same `/context/` prefix as the gathered slices but OUTSIDE
 * `PR_CONTEXT_KINDS` (those are gather inputs + the manifest contract).
 *
 * One object per (repo, PR, command): `v1/prs/{repo}/{pr}/context/{command}.md`.
 * Overwrite semantics — re-running `/zai review` replaces the latest result.
 * Written with a raw `bucket.put` (no D1 index, no manifest coupling), exactly
 * like the incremental slice refresh. Retention rides the same `v1/prs/`
 * lifecycle rule as the gathered context.
 */
export function prCommandResultKey(repositoryId, prNumber, command) {
  return `v${STORAGE_SCHEMA_VERSION}/prs/${component(repositoryId, 'repository id')}/${component(prNumber, 'pr number')}/context/${component(command, 'command')}.md`;
}

/**
 * R2 key for the generated, structured PR context used as auxiliary input by
 * future LLM commands. It is keyed per PR and overwritten only when a newer
 * manifest/headSha has been summarized.
 */
export function prSummaryKey(repositoryId, prNumber) {
  return `v${STORAGE_SCHEMA_VERSION}/prs/${component(repositoryId, 'repository id')}/${component(prNumber, 'pr number')}/context/pr-summary.json`;
}
