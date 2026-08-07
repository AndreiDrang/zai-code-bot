import { PR_PREVIEW_MARKER, PR_CLOSED_MARKER } from '../../../shared/constants.js';
import { upsertComment } from '../../../shared/comments.js';
import { renderPrPreview, renderPrClosed } from '../../../shared/pr-preview.js';
import { artifactExpiresAt, writeArtifact } from '../../../shared/storage/artifacts.js';
import { getRepositoryConfig } from '../../../shared/storage/config.js';
import { linkRunResultArtifact } from '../../../shared/storage/jobs.js';
import { prPreviewCacheKey, runArtifactKey } from '../../../shared/storage/keys.js';

const COMMENT_KIND = 'pr_preview';

/**
 * Publishes the metadata-only PR preview. No stats are computed or stored —
 * the brief is a lightweight identity card; per-file analysis lives in the
 * heavy /zai review pipeline. The rendered comment is still persisted to R2
 * (result artifact) for audit/replay.
 */
export async function handlePrPreviewJob({ github, env, db, job, runId }) {
  const config = await getRepositoryConfig(db, env.BOT_CACHE, job.repository_id);
  if (!config.enabled || !config.autoPreview) return { status: 'disabled' };

  // Closed lifecycle: post a one-time "PR closed by @X" announcement and leave
  // the preview comment untouched. closed_by was captured from the webhook
  // sender (GitHub's PR API does not expose it) and persisted on pull_requests.
  if (job.state === 'closed') {
    return publishClosedComment({ github, env, db, job, runId });
  }

  const currentPullRequest = await github.getPullRequest(
    job.repository_owner,
    job.repository_name,
    job.pr_number,
  );
  if (currentPullRequest?.head?.sha && currentPullRequest.head.sha !== job.head_sha) {
    return { status: 'superseded', headSha: currentPullRequest.head.sha };
  }

  const body = renderPrPreview({
    repository: job.repository_full_name,
    prNumber: job.pr_number,
    headSha: job.head_sha,
    title: job.title,
    authorLogin: job.author_login,
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

/**
 * Posts the idempotent "PR closed by @X" lifecycle comment. Skips the
 * supersede guard (head SHA is irrelevant for a close) and leaves the preview
 * comment untouched. `closed_by` was captured from the webhook sender and
 * persisted on pull_requests by createPrPreviewJob.
 */
async function publishClosedComment({ github, env, db, job, runId }) {
  const body = renderPrClosed({ closedBy: job.closed_by });
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
    commentKind: 'pr_closed',
    marker: PR_CLOSED_MARKER,
    body,
    bodyArtifactId: resultArtifact.artifactId,
    jobId: job.job_id,
    botLogin: env.GITHUB_BOT_LOGIN || null,
  });

  return {
    status: 'success',
    action: 'pr_closed',
    artifactKey: runArtifactKey(job.job_id, runId, 'result', 'md'),
  };
}

export function canHandle(commandType) {
  return commandType === COMMENT_KIND;
}
