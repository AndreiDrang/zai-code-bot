import {
  prContextKey,
  prContextV2DiffKey,
  prContextV2Key,
  prCardKey,
} from '../../../shared/storage/keys.js';
import { getRepositoryConfig } from '../../../shared/storage/config.js';
import { createLogger } from '../../../shared/logging.js';
import { projectComments } from '../../../shared/pr-comments.js';
import { createPrSummaryJob } from '../../../shared/storage/deliveries.js';
import { publishOutboxJob } from '../../../shared/storage/jobs.js';
import {
  MAX_SNAPSHOT_FILE_DIFF_BYTES,
  MAX_SNAPSHOT_TOTAL_DIFF_BYTES,
  utf8ByteLength,
} from '../../../shared/context/context-limits.js';

/**
 * Eager PR-context gather job.
 *
 * Writes the PR's task context to R2 under per-PR keys. V1 is dual-written
 * temporarily for compatibility; V2 stores one patch per file under
 * `v2/prs/{repo}/{pr}/context/diffs/`. A small PR card is written to KV so
 * command handlers can read the PR shape without calling getPullRequest.
 *
 * After the source context is committed, this schedules a separate `pr_summary`
 * job. The summary job owns the LLM call and is published through the shared D1
 * outbox, so this gather remains retryable and does not call the provider.
 */

const PR_CARD_TTL_SECONDS = 30 * 24 * 60 * 60; // 30d — matches the R2 context lifecycle
const DEFAULT_MAX_CONTEXT_BYTES = 200000;
const COMMIT_CAP = 100;

export async function handlePrContextJob({ github, env, db, job }) {
  const logger = createLogger(env, 'zai-heavy-worker:pr-context');
  const bucket = env.BOT_ARTIFACTS;
  const cache = env.BOT_CACHE;
  const { repository_id: repoId, pr_number: prNumber, head_sha: headSha } = job;
  const legacyManifestKey = prContextKey(repoId, prNumber, 'manifest');
  const manifestKey = prContextV2Key(repoId, prNumber, 'manifest');

  // V1-only snapshots are re-gathered once so V2 is backfilled. Subsequent
  // redeliveries skip only when the V2 manifest describes this same head.
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

  // Compact projections — store what consumers need, not raw API blobs. The
  // raw page is kept separately so the diff can be reconstructed from the
  // per-file patches when GitHub refuses the unified diff (PRs > 300 files).
  const rawFiles = Array.isArray(filesPage) ? filesPage : [];
  const files = rawFiles.slice(0, maxFiles).map((f) => ({
    filename: f.filename,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    changes: f.changes,
  }));
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
  const v2Diffs = await buildV2DiffArtifacts(rawFiles.slice(0, maxFiles), repoId, prNumber);

  // V1 compatibility only: existing consumers still read one aggregate diff.
  // V2 persists individual patches without this LLM prompt budget or silent
  // storage truncation. GitHub's unified diff remains the preferred legacy
  // representation, with per-file patches as its fallback.
  const unifiedDiff = typeof diff === 'string' && diff.length ? diff : '';
  let diffSource = 'none';
  if (unifiedDiff) {
    diffSource = 'unified';
  } else if (rawFiles.some((f) => typeof f.patch === 'string' && f.patch.length)) {
    diffSource = 'reconstructed';
  }
  const diffText = (unifiedDiff || reconstructDiff(rawFiles.slice(0, maxFiles))).slice(0, maxBytes);

  const aggregates = aggregateFiles(files);
  const gatheredAt = new Date().toISOString();

  // V1 continues dual-writing for compatibility. V2 stores one patch object
  // per file; its manifest is written last and commits a complete snapshot.
  if (bucket?.put) {
    const k = (kind) => prContextKey(repoId, prNumber, kind);
    await Promise.all([
      putJson(bucket, k('files'), files),
      putText(bucket, k('diff'), diffText, 'text/x-diff'),
      putJson(bucket, k('commits'), commitsPayload),
      putText(bucket, k('description'), pullRequest?.body || '', 'text/markdown'),
      putJson(bucket, k('comments'), commentsPayload),
      ...v2Diffs.artifacts.map((artifact) =>
        putText(bucket, artifact.key, artifact.patch, 'text/x-diff'),
      ),
      putJson(bucket, prContextV2Key(repoId, prNumber, 'files'), v2Diffs.files),
      putJson(bucket, prContextV2Key(repoId, prNumber, 'commits'), commitsPayload),
      putText(
        bucket,
        prContextV2Key(repoId, prNumber, 'description'),
        pullRequest?.body || '',
        'text/markdown',
      ),
      putJson(bucket, prContextV2Key(repoId, prNumber, 'comments'), commentsPayload),
    ]);

    const legacyManifest = {
      repositoryId: repoId,
      prNumber,
      headSha,
      baseSha: pullRequest?.base?.sha ?? job.base_sha ?? null,
      title: pullRequest?.title ?? job.title ?? null,
      authorLogin: pullRequest?.user?.login ?? job.author_login ?? null,
      gatheredAt,
      contextPrefix: `v1/prs/${repoId}/${prNumber}/context`,
      aggregates,
      counts: {
        files: files.length,
        commits: commitsPayload.length,
        issueComments: commentsPayload.issue.length,
        reviewComments: commentsPayload.review.length,
      },
      truncated: { diffBytes: diffText.length, maxBytes, diffSource },
    };
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
        storedDiffBytes: v2Diffs.storedDiffBytes,
      },
      counts: {
        files: v2Diffs.files.length,
        commits: commitsPayload.length,
        issueComments: commentsPayload.issue.length,
        reviewComments: commentsPayload.review.length,
        diffsAvailable: v2Diffs.artifacts.length,
        diffsUnavailable: v2Diffs.files.length - v2Diffs.artifacts.length,
      },
      limits: {
        maxFileDiffBytes: MAX_SNAPSHOT_FILE_DIFF_BYTES,
        maxTotalDiffBytes: MAX_SNAPSHOT_TOTAL_DIFF_BYTES,
      },
    };
    await putJson(bucket, legacyManifestKey, legacyManifest);
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
        message: error?.message,
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

async function buildV2DiffArtifacts(rawFiles, repoId, prNumber) {
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
      key = prContextV2DiffKey(repoId, prNumber, path);
    } catch {
      entry.diff = { state: 'unavailable', reason: 'invalid_path', bytes };
      files.push(entry);
      continue;
    }
    entry.diff = {
      state: 'available',
      key,
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

/**
 * Build a unified-diff-shaped string from the per-file `patch` fields returned
 * by the List-Files API. This is the GitHub-recommended fallback when the PR's
 * unified .diff media type is refused ("diff exceeded the maximum number of
 * files (300)") or otherwise unavailable. Output is bounded by the caller via
 * maxBytes before it reaches R2.
 */
function reconstructDiff(files) {
  const parts = [];
  for (const f of files) {
    if (typeof f.patch !== 'string' || !f.patch) continue;
    parts.push(
      `diff --git a/${f.filename} b/${f.filename}`,
      `--- a/${f.filename}`,
      `+++ b/${f.filename}`,
      f.patch,
    );
  }
  return parts.join('\n');
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
