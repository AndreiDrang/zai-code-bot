import { PR_PREVIEW_MARKER, PR_CLOSED_MARKER } from '../../../shared/constants.js';
import { upsertComment } from '../../../shared/comments.js';
import { renderPrPreview, renderPrClosed } from '../../../shared/pr-preview.js';
import { getRepositoryConfig } from '../../../shared/storage/config.js';

const COMMENT_KIND = 'pr_preview';

/**
 * Publishes the metadata-only PR preview. No stats are computed and nothing is
 * written to R2/KV — the brief is a lightweight identity card drawn entirely
 * from the job row; per-file analysis lives in the heavy /zai review pipeline.
 */
export async function handlePrPreviewJob({ github, env, db, job }) {
  const config = await getRepositoryConfig(db, env.BOT_CACHE, job.repository_id);
  if (!config.enabled || !config.autoPreview) return { status: 'disabled' };

  // Closed lifecycle: post a one-time "PR closed by @X" announcement and leave
  // the preview comment untouched. closed_by was captured from the webhook
  // sender (GitHub's PR API does not expose it) and persisted on pull_requests.
  if (job.state === 'closed') {
    return publishClosedComment({ github, env, db, job });
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
    jobId: job.job_id,
    botLogin: env.GITHUB_BOT_LOGIN || null,
  });

  return { status: 'success', action: COMMENT_KIND };
}

/**
 * Posts the idempotent "PR closed by @X" lifecycle comment. Skips the
 * supersede guard (head SHA is irrelevant for a close) and leaves the preview
 * comment untouched. `closed_by` was captured from the webhook sender and
 * persisted on pull_requests by createPrPreviewJob.
 */
async function publishClosedComment({ github, env, db, job }) {
  const body = renderPrClosed({ closedBy: job.closed_by });

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
    jobId: job.job_id,
    botLogin: env.GITHUB_BOT_LOGIN || null,
  });

  return { status: 'success', action: 'pr_closed' };
}

export function canHandle(commandType) {
  return commandType === COMMENT_KIND;
}
