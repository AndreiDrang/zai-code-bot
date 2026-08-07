import { prContextKey, prCardKey } from '../../../shared/storage/keys.js';
import { getRepositoryConfig } from '../../../shared/storage/config.js';
import { createLogger } from '../../../shared/logging.js';

/**
 * Eager PR-context gather job.
 *
 * Writes the PR's TASK CONTEXT to R2 under deterministic keys
 * (`v1/prs/{repo}/{pr}/{head}/context/{kind}`) and a small PR "card" to KV
 * (`v1:pr-card:{repo}:{pr}`). R2 context is the blob tier reused by the heavy
 * review/impact handlers (no re-fetch); the KV card lets command handlers read
 * the PR's shape without calling getPullRequest.
 *
 * No LLM, no comment. Idempotent per head: a manifest already present for this
 * headSha short-circuits a redelivery before any fetch.
 */

const PR_CARD_TTL_SECONDS = 30 * 24 * 60 * 60; // 30d — matches the R2 context lifecycle
const DEFAULT_MAX_CONTEXT_BYTES = 200000;
const COMMIT_CAP = 100;

export async function handlePrContextJob({ github, env, db, job }) {
  const logger = createLogger(env, 'zai-heavy-worker:pr-context');
  const bucket = env.BOT_ARTIFACTS;
  const cache = env.BOT_CACHE;
  const { repository_id: repoId, pr_number: prNumber, head_sha: headSha } = job;
  const manifestKey = prContextKey(repoId, prNumber, headSha, 'manifest');

  // Idempotency: a manifest for this head means a prior gather already won.
  if (bucket?.head) {
    const present = await bucket.head(manifestKey).catch(() => null);
    if (present) return { status: 'skipped', action: 'pr_context', reason: 'manifest_exists' };
  }

  const config = await getRepositoryConfig(db, cache, repoId);
  const maxBytes = Number(config.maxContextBytes) || DEFAULT_MAX_CONTEXT_BYTES;
  const maxFiles = Math.max(1, Number(config.maxFiles) || 100);
  const owner = job.repository_owner;
  const name = job.repository_name;

  // Fetch all slices in parallel; a single slice failure degrades but does not
  // abort the gather (the manifest records what was actually captured).
  const [pullRequest, filesPage, diff, commits, comments] = await Promise.all([
    github.getPullRequest(owner, name, prNumber).catch(() => null),
    github.getPrFiles(owner, name, prNumber, 1, Math.min(maxFiles, 100)).catch(() => []),
    github.getPrDiff(owner, name, prNumber).catch(() => ''),
    github.getPrCommits(owner, name, prNumber, 1, COMMIT_CAP).catch(() => []),
    github
      .getPrComments(owner, name, prNumber, { maxComments: 100 })
      .catch(() => ({ issue: [], review: [] })),
  ]);

  // Compact projections — store what consumers need, not raw API blobs.
  const files = (Array.isArray(filesPage) ? filesPage : []).slice(0, maxFiles).map((f) => ({
    filename: f.filename,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    changes: f.changes,
  }));
  const commitsPayload = (Array.isArray(commits) ? commits : []).slice(0, COMMIT_CAP).map((c) => ({
    sha: c.sha,
    message: String(c.commit?.message || '').split('\n')[0],
    author: c.commit?.author?.name || c.author?.login || null,
    date: c.commit?.author?.date || null,
  }));
  const commentsPayload = {
    issue: (comments.issue || []).map((c) => ({
      user: c.user?.login,
      body: c.body,
      created_at: c.created_at,
    })),
    review: (comments.review || []).map((c) => ({
      user: c.user?.login,
      body: c.body,
      path: c.path,
      line: c.line,
    })),
  };
  const diffText = typeof diff === 'string' ? diff.slice(0, maxBytes) : '';

  const aggregates = aggregateFiles(files);
  const gatheredAt = new Date().toISOString();

  // Write the five context slices (deterministic keys). The manifest is written
  // LAST so a crash before it leaves the gather retryable (no false "already
  // gathered" marker); on retry every slice is re-fetched and overwritten.
  if (bucket?.put) {
    const k = (kind) => prContextKey(repoId, prNumber, headSha, kind);
    await Promise.all([
      putJson(bucket, k('files'), files),
      putText(bucket, k('diff'), diffText, 'text/x-diff'),
      putJson(bucket, k('commits'), commitsPayload),
      putText(bucket, k('description'), pullRequest?.body || '', 'text/markdown'),
      putJson(bucket, k('comments'), commentsPayload),
    ]);

    const manifest = {
      repositoryId: repoId,
      prNumber,
      headSha,
      title: pullRequest?.title ?? job.title ?? null,
      authorLogin: pullRequest?.user?.login ?? job.author_login ?? null,
      gatheredAt,
      contextPrefix: `v1/prs/${repoId}/${prNumber}/${headSha}/context`,
      aggregates,
      counts: {
        files: files.length,
        commits: commitsPayload.length,
        issueComments: commentsPayload.issue.length,
        reviewComments: commentsPayload.review.length,
      },
      truncated: { diffBytes: diffText.length, maxBytes },
    };
    await putJson(bucket, manifestKey, manifest);
  }

  // KV pr-card: small hot shape snapshot. Keyed by (repo, pr) — NOT headSha —
  // so command handlers read the latest gathered shape without getPullRequest.
  if (cache?.put) {
    const card = {
      repositoryId: repoId,
      prNumber,
      headSha,
      title: pullRequest?.title ?? job.title ?? null,
      authorLogin: pullRequest?.user?.login ?? job.author_login ?? null,
      state: pullRequest?.state ?? job.state ?? 'open',
      changedFiles: pullRequest?.changed_files ?? aggregates.changedFiles,
      additions: pullRequest?.additions ?? aggregates.additions,
      deletions: pullRequest?.deletions ?? aggregates.deletions,
      contextReady: true,
      contextPrefix: `v1/prs/${repoId}/${prNumber}/${headSha}/context`,
      gatheredAt,
    };
    await cache
      .put(prCardKey(repoId, prNumber), JSON.stringify(card), {
        expirationTtl: PR_CARD_TTL_SECONDS,
      })
      .catch(() => {
        /* KV is derivative — a failed card write degrades, not fails */
      });
  }

  logger.info('Gathered PR context', {
    repo: job.repository_full_name,
    pr: prNumber,
    headSha,
    files: files.length,
    commits: commitsPayload.length,
  });

  return {
    status: 'success',
    action: 'pr_context',
    counts: {
      files: files.length,
      commits: commitsPayload.length,
      comments: commentsPayload.issue.length + commentsPayload.review.length,
    },
  };
}

function aggregateFiles(files) {
  let additions = 0;
  let deletions = 0;
  for (const f of files) {
    additions += Number(f.additions) || 0;
    deletions += Number(f.deletions) || 0;
  }
  return { changedFiles: files.length, additions, deletions };
}

function putJson(bucket, key, value) {
  return bucket.put(key, JSON.stringify(value), {
    httpMetadata: { contentType: 'application/json' },
  });
}

function putText(bucket, key, text, contentType) {
  return bucket.put(key, text, { httpMetadata: { contentType } });
}

export function canHandle(commandType) {
  return commandType === 'pr_context';
}
