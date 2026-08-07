import { PR_PREVIEW_MARKER } from '../../../shared/constants.js';
import { upsertComment } from '../../../shared/comments.js';
import { fetchPrStats } from '../../../shared/pr-stats.js';
import { renderPrPreview } from '../../../shared/pr-preview.js';
import { artifactExpiresAt, writeArtifact } from '../../../shared/storage/artifacts.js';
import { getRepositoryConfig } from '../../../shared/storage/config.js';
import { linkRunResultArtifact } from '../../../shared/storage/jobs.js';
import { prPreviewCacheKey, runArtifactKey } from '../../../shared/storage/keys.js';

const COMMENT_KIND = 'pr_preview';

/**
 * Builds and publishes a bounded PR preview. The job contains only IDs and
 * metadata; large file manifests and rendered output are stored in R2.
 */
export async function handlePrPreviewJob({ github, env, db, job, runId }) {
  const config = await getRepositoryConfig(db, env.BOT_CACHE, job.repository_id);
  if (!config.enabled || !config.autoPreview) return { status: 'disabled' };

  const currentPullRequest = await github.getPullRequest(
    job.repository_owner,
    job.repository_name,
    job.pr_number,
  );
  if (currentPullRequest?.head?.sha && currentPullRequest.head.sha !== job.head_sha) {
    return { status: 'superseded', headSha: currentPullRequest.head.sha };
  }

  const stats = await fetchPrStats(
    github,
    job.repository_owner,
    job.repository_name,
    job.pr_number,
    { maxFiles: config.maxFiles },
  );
  const manifest = {
    repositoryId: job.repository_id,
    repository: job.repository_full_name,
    prNumber: job.pr_number,
    headSha: job.head_sha,
    stats,
  };
  await writeArtifact({
    bucket: env.BOT_ARTIFACTS,
    db,
    jobId: job.job_id,
    runId,
    kind: 'files',
    content: JSON.stringify(manifest),
    expiresAt: artifactExpiresAt(new Date(), env.R2_RETENTION_DAYS),
  });

  const body = renderPrPreview({
    repository: job.repository_full_name,
    prNumber: job.pr_number,
    headSha: job.head_sha,
    title: job.title,
    authorLogin: job.author_login,
    stats,
  });
  const resultArtifact = await writeArtifact({
    bucket: env.BOT_ARTIFACTS,
    db,
    jobId: job.job_id,
    runId,
    kind: 'result',
    extension: 'md',
    contentType: 'text/markdown; charset=utf-8',
    content: body,
    expiresAt: artifactExpiresAt(new Date(), env.R2_RETENTION_DAYS),
  });
  await linkRunResultArtifact(db, runId, resultArtifact.artifactId);

  await upsertComment({
    github,
    db,
    owner: job.repository_owner,
    repo: job.repository_name,
    issueNumber: job.pr_number,
    repositoryId: job.repository_id,
    headSha: job.head_sha,
    commentKind: COMMENT_KIND,
    marker: PR_PREVIEW_MARKER,
    body,
    bodyArtifactId: resultArtifact.artifactId,
    jobId: job.job_id,
    botLogin: env.GITHUB_BOT_LOGIN || null,
  });

  if (env.BOT_CACHE?.put) {
    try {
      await env.BOT_CACHE.put(
        prPreviewCacheKey(job.repository_id, job.pr_number, job.head_sha),
        body,
        { expirationTtl: 3600 },
      );
    } catch {
      // Cache is derivative; an outage must not retry a completed publication.
    }
  }

  return {
    status: 'success',
    action: COMMENT_KIND,
    artifactKey: runArtifactKey(job.job_id, runId, 'result', 'md'),
  };
}

export function canHandle(commandType) {
  return commandType === COMMENT_KIND;
}
