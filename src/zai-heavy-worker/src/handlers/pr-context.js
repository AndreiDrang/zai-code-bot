import { prContextDiffKey, prContextKey, prCardKey } from '../../../shared/storage/keys.js';
import { createLogger } from '../../../shared/logging.js';
import { projectComments } from '../../../shared/pr-comments.js';
import {
  createPrSummaryJob,
  getCurrentPullRequestHead,
} from '../../../shared/storage/deliveries.js';
import { publishOutboxJob } from '../../../shared/storage/jobs.js';
import {
  MAX_SNAPSHOT_FILE_DIFF_BYTES,
  MAX_SNAPSHOT_TOTAL_DIFF_BYTES,
  utf8ByteLength,
} from '../../../shared/context/context-limits.js';

/**
 * Eager PR-context gather job.
 *
 * Writes the PR's task context to R2 under a V2 per-PR snapshot. Each changed
 * file stores one patch under
 * `v2/prs/{repo}/{pr}/context/diffs/`. A small PR card is written to KV so
 * command handlers can read the PR shape without calling getPullRequest.
 *
 * After the source context is committed, this schedules a separate `pr_summary`
 * job. The summary job owns the LLM call and is published through the shared D1
 * outbox, so this gather remains retryable and does not call the provider.
 */

const PR_CARD_TTL_SECONDS = 30 * 24 * 60 * 60; // 30d — matches the R2 context lifecycle
const COMMIT_CAP = 100;

export async function handlePrContextJob({ github, env, db, job }) {
  const logger = createLogger(env, 'zai-heavy-worker:pr-context');
  const bucket = env.BOT_ARTIFACTS;
  const cache = env.BOT_CACHE;
  const { repository_id: repoId, pr_number: prNumber, head_sha: headSha } = job;
  const manifestKey = prContextKey(repoId, prNumber, 'manifest');

  // Avoid even a redelivery-side summary enqueue when D1 already knows a newer
  // synchronize event for this pull request.
  const recordedHeadSha = await getCurrentPullRequestHead(db, repoId, prNumber);
  if (recordedHeadSha && recordedHeadSha !== headSha) {
    return {
      status: 'stale',
      action: 'pr_context',
      headSha,
      currentHeadSha: recordedHeadSha,
    };
  }

  // Redeliveries skip only when the committed V2 manifest describes this head.
  const existingHead = await readManifestHead(bucket, manifestKey);
  if (existingHead && existingHead === headSha) {
    const summaryJob = await ensureSummaryJob(db, bucket, job, env, logger);
    return {
      status: 'skipped',
      action: 'pr_context',
      reason: 'same_head_manifest_exists',
      summaryJobId: summaryJob?.job?.job_id || null,
    };
  }

  const owner = job.repository_owner;
  const name = job.repository_name;

  // Fetch all slices in parallel; a single slice failure degrades but does not
  // abort the gather (the manifest records what was actually captured).
  const [pullRequest, filesPage, commits, comments] = await Promise.all([
    github.getPullRequest(owner, name, prNumber).catch(() => null),
    github.getAllPrFiles(owner, name, prNumber).catch(() => []),
    github.getPrCommits(owner, name, prNumber, 1, COMMIT_CAP).catch(() => []),
    github
      .getPrComments(owner, name, prNumber, { maxComments: 100 })
      .catch(() => ({ issue: [], review: [] })),
  ]);

  // A delayed delivery can finish after a newer synchronize event. Do not
  // write a snapshot for an old webhook head when GitHub already tells us
  // about the newer one.
  if (pullRequest?.head?.sha && pullRequest.head.sha !== headSha) {
    return {
      status: 'stale',
      action: 'pr_context',
      headSha,
      currentHeadSha: pullRequest.head.sha,
    };
  }

  // Compact projections — store what consumers need, not raw API blobs.
  const rawFiles = Array.isArray(filesPage) ? filesPage : [];
  const commitsPayload = (Array.isArray(commits) ? commits : []).slice(0, COMMIT_CAP).map((c) => {
    const message = String(c.commit?.message || '');
    return {
      sha: c.sha,
      title: message.split('\n')[0],
      message, // full commit message (subject + body), not just the subject line
      author: c.commit?.author?.name || c.author?.login || null,
      date: c.commit?.author?.date || null,
    };
  });
  // Shared projection — identical to the incremental comment-refresh path
  // (shared/pr-comments.js), so the gather and the issue_comment refresh never
  // drift in the stored slice shape. Includes `updated_at` so edits are visible.
  const commentsPayload = projectComments(comments);
  const diffArtifacts = await buildDiffArtifacts(rawFiles, repoId, prNumber);

  const aggregates = aggregateFiles(diffArtifacts.files);
  const gatheredAt = new Date().toISOString();

  // Queue deliveries are at-least-once and synchronize events for one PR can
  // overlap. Webhook ingestion updates this D1 row before queue publication,
  // so an older job must not replace context for a newer PR head.
  const currentHeadSha = await getCurrentPullRequestHead(db, repoId, prNumber);
  if (currentHeadSha && currentHeadSha !== headSha) {
    return {
      status: 'stale',
      action: 'pr_context',
      headSha,
      currentHeadSha,
    };
  }

  // Store each patch independently. The manifest is written last and commits
  // a complete V2 snapshot to readers. R2 is strongly consistent, therefore
  // a summary job published after this marker can read it immediately.
  if (bucket?.put) {
    await Promise.all([
      ...diffArtifacts.artifacts.map((artifact) =>
        putText(bucket, artifact.key, artifact.patch, 'text/x-diff'),
      ),
      putJson(bucket, prContextKey(repoId, prNumber, 'files'), diffArtifacts.files),
      putJson(bucket, prContextKey(repoId, prNumber, 'commits'), commitsPayload),
      putText(
        bucket,
        prContextKey(repoId, prNumber, 'description'),
        pullRequest?.body || '',
        'text/markdown',
      ),
      putJson(bucket, prContextKey(repoId, prNumber, 'comments'), commentsPayload),
    ]);

    const manifest = {
      schemaVersion: 2,
      repositoryId: repoId,
      prNumber,
      headSha,
      baseSha: pullRequest?.base?.sha ?? job.base_sha ?? null,
      title: pullRequest?.title ?? job.title ?? null,
      authorLogin: pullRequest?.user?.login ?? job.author_login ?? null,
      gatheredAt,
      contextPrefix: `v2/prs/${repoId}/${prNumber}/context`,
      artifacts: {
        description: 'description.md',
        commits: 'commits.json',
        files: 'files.json',
        comments: 'comments.json',
        diffsPrefix: 'diffs/',
      },
      aggregates: {
        ...aggregates,
        storedDiffBytes: diffArtifacts.storedDiffBytes,
      },
      counts: {
        files: diffArtifacts.files.length,
        commits: commitsPayload.length,
        issueComments: commentsPayload.issue.length,
        reviewComments: commentsPayload.review.length,
        diffsAvailable: diffArtifacts.artifacts.length,
        diffsUnavailable: diffArtifacts.files.length - diffArtifacts.artifacts.length,
      },
      limits: {
        maxFileDiffBytes: MAX_SNAPSHOT_FILE_DIFF_BYTES,
        maxTotalDiffBytes: MAX_SNAPSHOT_TOTAL_DIFF_BYTES,
      },
    };
    await putJson(bucket, manifestKey, manifest);

    // Only enqueue dependent work after the commit marker is readable and
    // still belongs to this gather. If another head won the write race, this
    // delivery must not summarize or advertise its now-stale snapshot.
    const committedHeadSha = await readManifestHead(bucket, manifestKey);
    if (!committedHeadSha) {
      const error = new Error('PR context manifest was not readable after commit');
      error.code = 'pr_context_manifest_commit_failed';
      error.retryable = true;
      throw error;
    }
    if (committedHeadSha !== headSha) {
      return {
        status: 'stale',
        action: 'pr_context',
        headSha,
        currentHeadSha: committedHeadSha,
      };
    }
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
      contextPrefix: `v2/prs/${repoId}/${prNumber}/context`,
      contextStorageVersion: 2,
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

  const summaryJob = await ensureSummaryJob(db, bucket, job, env, logger);

  logger.info('Gathered PR context', {
    repo: job.repository_full_name,
    pr: prNumber,
    headSha,
    files: diffArtifacts.files.length,
    commits: commitsPayload.length,
  });

  return {
    status: 'success',
    action: 'pr_context',
    counts: {
      files: diffArtifacts.files.length,
      commits: commitsPayload.length,
      comments: commentsPayload.issue.length + commentsPayload.review.length,
    },
    summaryJobId: summaryJob?.job?.job_id || null,
  };
}

async function ensureSummaryJob(db, bucket, job, env, logger) {
  // A local/unit gather without D1 or R2 is still useful for the source
  // collection tests, but cannot produce a durable LLM job.
  if (!bucket?.put || !db?.prepare) return null;
  const summaryJob = await createPrSummaryJob(db, job);
  if (summaryJob.created && env?.BOT_JOBS?.send) {
    try {
      await publishOutboxJob(env, db, summaryJob.job.job_id);
    } catch (error) {
      // The outbox remains unpublished and the main-worker cron will replay it.
      logger.warn('PR summary enqueue deferred to outbox replay', {
        jobId: summaryJob.job.job_id,
        errorMessage: error?.message,
      });
    }
  }
  return summaryJob;
}

async function readManifestHead(bucket, manifestKey) {
  if (!bucket?.get) return null;
  if (typeof bucket.list === 'function') {
    const listed = await bucket.list({ prefix: manifestKey, limit: 1 }).catch(() => null);
    if (listed && !listed.objects?.some((object) => object.key === manifestKey)) {
      return null;
    }
  } else if (typeof bucket.head === 'function') {
    const metadata = await bucket.head(manifestKey).catch(() => null);
    if (!metadata) return null;
  }
  const object = await bucket.get(manifestKey).catch(() => null);
  if (!object) return null;
  try {
    return (JSON.parse(await object.text()) || {}).headSha ?? null;
  } catch {
    return null;
  }
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

async function buildDiffArtifacts(rawFiles, repoId, prNumber) {
  const files = [];
  const artifacts = [];
  let storedDiffBytes = 0;

  for (const source of rawFiles) {
    const path = typeof source?.filename === 'string' ? source.filename : '';
    if (!path) continue;
    const patch = typeof source.patch === 'string' && source.patch.length ? source.patch : null;
    const entry = {
      path,
      previousPath: source.previous_filename || null,
      status: source.status || 'modified',
      additions: Number(source.additions) || 0,
      deletions: Number(source.deletions) || 0,
      changes: Number(source.changes) || 0,
      binary: Boolean(source.binary),
      diff: null,
    };

    if (!patch) {
      entry.diff = {
        state: 'unavailable',
        reason: entry.binary ? 'binary_file' : 'patch_unavailable',
        bytes: null,
      };
      files.push(entry);
      continue;
    }

    const bytes = utf8ByteLength(patch);
    if (bytes > MAX_SNAPSHOT_FILE_DIFF_BYTES) {
      entry.diff = { state: 'unavailable', reason: 'file_diff_too_large', bytes };
      files.push(entry);
      continue;
    }
    if (storedDiffBytes + bytes > MAX_SNAPSHOT_TOTAL_DIFF_BYTES) {
      entry.diff = { state: 'unavailable', reason: 'snapshot_diff_budget_exceeded', bytes };
      files.push(entry);
      continue;
    }

    let key;
    try {
      key = prContextDiffKey(repoId, prNumber, path);
    } catch {
      entry.diff = { state: 'unavailable', reason: 'invalid_path', bytes };
      files.push(entry);
      continue;
    }
    entry.diff = {
      state: 'available',
      bytes,
      sha256: await sha256Hex(patch),
    };
    files.push(entry);
    artifacts.push({ key, patch });
    storedDiffBytes += bytes;
  }

  return { files, artifacts, storedDiffBytes };
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
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
