/**
 * Versioned key builders shared by the D1, R2, and KV storage adapters.
 */

export const STORAGE_SCHEMA_VERSION = 1;
export const PR_PREVIEW_JOB_KIND = 'pr_preview';
export const PR_CONTEXT_JOB_KIND = 'pr_context';
export const SUPPORTED_JOB_KINDS = [PR_PREVIEW_JOB_KIND, PR_CONTEXT_JOB_KIND, 'review', 'impact'];

/**
 * R2 context kinds gathered per PR head. Each maps to a deterministic object
 * under `v1/prs/{repo}/{pr}/{head}/context/{kind}.{ext}`. The `manifest` is
 * the idempotency marker (written last) + the index the consumers read first.
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
 * R2 key for one gathered context object, deterministic from
 * (repositoryId, prNumber, headSha, kind). Determinism gives PR↔R2 linking in
 * both directions without a D1 index table; retention is an R2 lifecycle rule
 * on the `v1/prs/` prefix (see wrangler.toml), NOT the D1 artifact sweep.
 */
export function prContextKey(repositoryId, prNumber, headSha, kind) {
  if (!PR_CONTEXT_KINDS.includes(kind)) {
    throw new TypeError(`Invalid PR context kind: ${kind}`);
  }
  return `v${STORAGE_SCHEMA_VERSION}/prs/${component(repositoryId, 'repository id')}/${component(prNumber, 'pr number')}/${component(headSha, 'head sha')}/context/${kind}.${CONTEXT_KIND_EXTENSION[kind]}`;
}
