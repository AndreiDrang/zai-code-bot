/**
 * Versioned key builders shared by the D1, R2, and KV storage adapters.
 */

export const STORAGE_SCHEMA_VERSION = 1;
export const PR_CONTEXT_JOB_KIND = 'pr_context';
export const PR_SUMMARY_JOB_KIND = 'pr_summary';
export const SUPPORTED_JOB_KINDS = [PR_CONTEXT_JOB_KIND, PR_SUMMARY_JOB_KIND, 'review', 'describe'];

/**
 * PR-context artifacts use their own version because deliveries, runs, and KV
 * cache keys do not participate in this storage-contract migration. Each
 * context snapshot is keyed per PR, with `manifest.headSha` identifying the
 * pull-request head it describes. Changed-file patches are separate objects
 * under `diffs/`; an aggregate `diff.diff` is intentionally not stored.
 */
export const PR_CONTEXT_STORAGE_VERSION = 2;
export const PR_CONTEXT_KINDS = Object.freeze([
  'manifest',
  'files',
  'commits',
  'description',
  'comments',
]);
const CONTEXT_KIND_EXTENSION = {
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
 * R2 key for one gathered V2 context object, keyed per PR (repositoryId,
 * prNumber, kind) — not per head SHA. The gather writes the manifest last,
 * making it the complete-snapshot commit marker.
 */
export function prContextKey(repositoryId, prNumber, kind) {
  if (!PR_CONTEXT_KINDS.includes(kind)) {
    throw new TypeError(`Invalid PR context kind: ${kind}`);
  }
  return `v${PR_CONTEXT_STORAGE_VERSION}/prs/${component(repositoryId, 'repository id')}/${component(prNumber, 'pr number')}/context/${kind}.${CONTEXT_KIND_EXTENSION[kind]}`;
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
export function prContextDiffKey(repositoryId, prNumber, path) {
  const safePath = normalizeRepositoryPath(path);
  return `v${PR_CONTEXT_STORAGE_VERSION}/prs/${component(repositoryId, 'repository id')}/${component(prNumber, 'pr number')}/context/diffs/${encodeURIComponent(safePath)}.patch`;
}

/**
 * R2 key for a COMMAND RESULT — the LLM output of one /zai command for one PR,
 * stored under the same `/context/` prefix as the gathered slices but OUTSIDE
 * `PR_CONTEXT_KINDS` (those are gathered context inputs + the manifest
 * contract).
 *
 * One object per (repo, PR, command): `v2/prs/{repo}/{pr}/context/{command}.md`.
 * Overwrite semantics — re-running `/zai review` replaces the latest result.
 * Written with a raw `bucket.put` (no D1 index, no manifest coupling), exactly
 * like the incremental slice refresh. Retention rides the same `v2/prs/`
 * lifecycle rule as the gathered context.
 */
export function prCommandResultKey(repositoryId, prNumber, command) {
  return `v${PR_CONTEXT_STORAGE_VERSION}/prs/${component(repositoryId, 'repository id')}/${component(prNumber, 'pr number')}/context/${component(command, 'command')}.md`;
}

/**
 * R2 key for the generated, structured PR context used as auxiliary input by
 * future LLM commands. It is keyed per PR and overwritten only when a newer
 * manifest/headSha has been summarized.
 */
export function prSummaryKey(repositoryId, prNumber) {
  return `v${PR_CONTEXT_STORAGE_VERSION}/prs/${component(repositoryId, 'repository id')}/${component(prNumber, 'pr number')}/context/pr-summary.json`;
}
