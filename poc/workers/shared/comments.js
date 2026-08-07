import { changedRows, first, prepare, run } from './storage/database.js';

const PUBLICATION_LEASE_SECONDS = 10 * 60;

function leaseExpiry(now, seconds = PUBLICATION_LEASE_SECONDS) {
  return new Date(new Date(now).getTime() + seconds * 1000).toISOString();
}

export async function findPublication(db, repositoryId, prNumber, commentKind) {
  return first(
    prepare(
      db,
      `SELECT repository_id, pr_number, comment_kind, current_head_sha, github_comment_id,
              marker, status, lease_job_id, lease_expires_at, body_artifact_id
       FROM comment_publications
       WHERE repository_id = ? AND pr_number = ? AND comment_kind = ?`,
      repositoryId,
      prNumber,
      commentKind,
    ),
  );
}

/** Atomically reserves the single live publication row for one job. */
export async function claimPublication(
  db,
  { repositoryId, prNumber, commentKind, marker, jobId },
  now = new Date().toISOString(),
) {
  const leaseExpiresAt = leaseExpiry(now);
  const result = await run(
    prepare(
      db,
      `INSERT INTO comment_publications
       (repository_id, pr_number, comment_kind, current_head_sha, github_comment_id,
        marker, status, lease_job_id, lease_expires_at, body_artifact_id, created_at, updated_at)
       VALUES (?, ?, ?, NULL, NULL, ?, 'publishing', ?, ?, NULL, ?, ?)
       ON CONFLICT(repository_id, pr_number, comment_kind) DO UPDATE SET
         marker = excluded.marker, status = 'publishing', lease_job_id = excluded.lease_job_id,
         lease_expires_at = excluded.lease_expires_at, updated_at = excluded.updated_at
       WHERE comment_publications.status != 'publishing'
          OR comment_publications.lease_job_id = excluded.lease_job_id
          OR comment_publications.lease_expires_at IS NULL
          OR comment_publications.lease_expires_at <= excluded.updated_at`,
      repositoryId,
      prNumber,
      commentKind,
      marker,
      jobId,
      leaseExpiresAt,
      now,
      now,
    ),
  );
  if (!changedRows(result)) return null;
  return findPublication(db, repositoryId, prNumber, commentKind);
}

export async function finalizePublication(
  db,
  { repositoryId, prNumber, commentKind, jobId, headSha, githubCommentId, marker, bodyArtifactId },
  now = new Date().toISOString(),
) {
  const result = await run(
    prepare(
      db,
      `UPDATE comment_publications
       SET current_head_sha = ?, github_comment_id = ?, marker = ?, status = 'published',
           lease_job_id = NULL, lease_expires_at = NULL, body_artifact_id = ?, updated_at = ?
       WHERE repository_id = ? AND pr_number = ? AND comment_kind = ?
         AND status = 'publishing' AND lease_job_id = ?`,
      headSha,
      githubCommentId,
      marker,
      bodyArtifactId,
      now,
      repositoryId,
      prNumber,
      commentKind,
      jobId,
    ),
  );
  return Number(result?.meta?.changes ?? result?.changes ?? 0) > 0;
}

/** Finds the bot-owned live comment and updates it, or creates it exactly once. */
export async function upsertComment({
  github,
  db,
  owner,
  repo,
  issueNumber,
  repositoryId,
  headSha,
  commentKind,
  marker,
  body,
  bodyArtifactId = null,
  jobId,
  botLogin = null,
}) {
  if (!jobId) throw new TypeError('A job ID is required for comment publication');
  const publication = await claimPublication(db, {
    repositoryId,
    prNumber: issueNumber,
    commentKind,
    marker,
    jobId,
  });
  if (!publication) {
    const existing = await findPublication(db, repositoryId, issueNumber, commentKind);
    return { id: existing?.github_comment_id || null, created: false, skipped: true };
  }

  const markerComment = await findMarkerComment(
    github,
    owner,
    repo,
    issueNumber,
    marker,
    botLogin,
    publication.github_comment_id,
  );
  const existing =
    markerComment &&
    (!publication.github_comment_id || markerComment.id === publication.github_comment_id)
      ? markerComment
      : null;
  const comment = existing
    ? await github.updateComment(owner, repo, existing.id, body)
    : await github.postComment(owner, repo, issueNumber, body);
  const finalized = await finalizePublication(db, {
    repositoryId,
    prNumber: issueNumber,
    commentKind,
    jobId,
    headSha,
    githubCommentId: comment.id,
    marker,
    bodyArtifactId,
  });
  if (!finalized) throw new Error('Comment publication lease was lost');
  return { id: comment.id, created: !existing };
}

async function findMarkerComment(
  github,
  owner,
  repo,
  issueNumber,
  marker,
  botLogin,
  expectedCommentId = null,
) {
  for (let page = 1; page <= 10; page += 1) {
    const comments = await github.getIssueComments(owner, repo, issueNumber, page, 100);
    if (!Array.isArray(comments) || comments.length === 0) return null;
    const botComments = comments.filter((comment) => {
      if (typeof comment.body !== 'string' || !comment.body.includes(marker)) return false;
      // The exact comment we previously published — tracked by id in
      // comment_publications — is unambiguously ours. Accept it regardless of
      // whether it was posted by a GitHub App (type 'Bot') or a PAT-owned bot
      // (type 'User'), so synchronize updates the existing comment instead of
      // creating a new one when GITHUB_BOT_LOGIN is not configured.
      if (expectedCommentId && comment.id === expectedCommentId) return true;
      const login = comment.user?.login;
      return comment.user?.type === 'Bot' || (botLogin && login === botLogin);
    });
    const match = expectedCommentId
      ? botComments.find((comment) => comment.id === expectedCommentId)
      : botComments[0];
    if (match) return match;
    if (comments.length < 100) return null;
  }
  return null;
}
