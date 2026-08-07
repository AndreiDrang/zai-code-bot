/**
 * Versioned key builders shared by the D1, R2, and KV storage adapters.
 */

export const STORAGE_SCHEMA_VERSION = 1;
export const PR_PREVIEW_JOB_KIND = 'pr_preview';
export const SUPPORTED_JOB_KINDS = [PR_PREVIEW_JOB_KIND, 'review', 'impact'];

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

export function repoConfigCacheKey(repositoryId, version) {
  return `v${STORAGE_SCHEMA_VERSION}:repo-config:${component(repositoryId, 'repository id')}:${component(version, 'config version')}`;
}

export function prPreviewCacheKey(repositoryId, prNumber, headSha) {
  return `v${STORAGE_SCHEMA_VERSION}:pr-preview:${component(repositoryId, 'repository id')}:${component(prNumber, 'PR number')}:${component(headSha, 'head SHA')}`;
}

export function jobStatusCacheKey(jobId) {
  return `v${STORAGE_SCHEMA_VERSION}:job-status:${component(jobId, 'job id')}`;
}
