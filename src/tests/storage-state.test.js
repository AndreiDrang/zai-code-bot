import { describe, expect, it, vi } from 'vitest';
import {
  batch,
  changedRows,
  first,
  prepare,
  requireBinding,
  run,
  safeErrorCode,
} from '../shared/storage/database.js';
import {
  createCommandJob,
  createPrContextJob,
  createPrSummaryJob,
  getCurrentPullRequestHead,
  getJob,
  getJobByDelivery,
} from '../shared/storage/deliveries.js';
import { getRepositoryConfig, saveRepositoryConfig } from '../shared/storage/config.js';
import {
  claimJob,
  linkRunResultArtifact,
  listDueOutbox,
  listDueStrandedJobs,
  listExpiredRunningJobs,
  recoverExpiredJob,
  markJobFailed,
  markJobRetryable,
  markJobSucceeded,
  markOutboxPublished,
  publishOutboxJob,
  recordOutboxFailure,
  startAnalysisRun,
} from '../shared/storage/jobs.js';
import { claimPublication, isBotOwnedComment, upsertComment } from '../shared/comments.js';

const job = {
  job_id: 'job-1',
  delivery_id: 'delivery-1',
  kind: 'review',
  repository_id: 10,
  pr_number: 7,
  head_sha: 'abc',
  status: 'queued',
  attempt_count: 0,
  available_at: '2020-01-01T00:00:00.000Z',
  repository_owner: 'owner',
  repository_name: 'repo',
  repository_full_name: 'owner/repo',
  title: 'Title',
  author_login: 'author',
};

function fakeDb({ firstValue = job, allValue = [{ job_id: 'job-1' }] } = {}) {
  const statements = [];
  const db = {
    statements,
    prepare(sql) {
      return {
        bind(...bindings) {
          const statement = {
            sql,
            bindings,
            first: vi.fn().mockResolvedValue(firstValue),
            all: vi.fn().mockResolvedValue({ results: allValue }),
            run: vi
              .fn()
              .mockResolvedValue({ meta: { changes: /^(UPDATE|INSERT)/.test(sql) ? 1 : 0 } }),
          };
          statements.push(statement);
          return statement;
        },
      };
    },
    batch: vi.fn().mockResolvedValue([]),
  };
  return db;
}

/** A structurally valid PR event for the delivery-race tests. */
function validEvent(deliveryId = 'd-race') {
  return {
    deliveryId,
    action: 'opened',
    repositoryId: 10,
    repository: { owner: 'owner', name: 'repo', fullName: 'owner/repo' },
    prNumber: 7,
    headSha: 'abc',
    baseSha: 'def',
    title: 'Title',
    authorLogin: 'author',
    state: 'open',
  };
}

describe('D1 storage adapters', () => {
  it('provides database validation and safe error helpers', async () => {
    const db = fakeDb();
    const statement = prepare(db, 'SELECT 1', 'x');
    expect(await first(statement)).toBe(job);
    expect(changedRows({ meta: { changes: 2 } })).toBe(2);
    expect(safeErrorCode({ status: 429 })).toBe('github_rate_limited');
    expect(safeErrorCode({ status: 503 })).toBe('github_unavailable');
    expect(safeErrorCode({ code: 'known_code' })).toBe('known_code');
    expect(safeErrorCode(new Error())).toBe('storage_error');
    expect(() => requireBinding(null, 'BOT_DB')).toThrow('BOT_DB');
    await expect(
      run({ run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }) }),
    ).resolves.toMatchObject({ changes: 1 });
    await expect(batch(db, [])).resolves.toEqual([]);
    expect(() => prepare(null, 'SELECT 1')).toThrow('D1');
    await expect(batch(null, [])).rejects.toThrow('D1');
    expect(changedRows({ changes: 3 })).toBe(3);
  });

  it('returns an existing delivery without creating a second transaction', async () => {
    const db = fakeDb();
    await expect(
      createPrContextJob(db, {
        deliveryId: 'delivery-1',
        repositoryId: 10,
        repository: { owner: 'o', name: 'r', fullName: 'o/r' },
        prNumber: 7,
        headSha: 'abc',
      }),
    ).resolves.toMatchObject({ created: false, job });
    expect(db.batch).not.toHaveBeenCalled();
  });

  it('rejects incomplete delivery input', async () => {
    await expect(createPrContextJob(fakeDb(), { deliveryId: 'only-id' })).rejects.toThrow(
      'Missing PR event field',
    );
  });

  it('deduplicates a delivery and creates a job transaction', async () => {
    const db = fakeDb({ firstValue: null });
    let selectCount = 0;
    db.prepare = (sql) => ({
      bind: (...bindings) => {
        const statement = {
          sql,
          bindings,
          first: vi
            .fn()
            .mockResolvedValue(
              sql.includes('FROM jobs') ? (selectCount++ === 0 ? null : job) : null,
            ),
          run: vi.fn(),
          all: vi.fn(),
        };
        return statement;
      },
    });
    const result = await createPrContextJob(db, {
      deliveryId: 'delivery-1',
      action: 'opened',
      repositoryId: 10,
      repository: { owner: 'owner', name: 'repo', fullName: 'owner/repo' },
      prNumber: 7,
      headSha: 'abc',
      baseSha: 'def',
      title: 'Title',
      authorLogin: 'author',
      state: 'open',
    });
    expect(result.created).toBe(true);
    expect(db.batch).toHaveBeenCalledOnce();
    expect(result.job.job_id).toBe('job-1');
  });

  it('reads a job by ID', async () => {
    await expect(getJob(fakeDb(), 'job-1')).resolves.toBe(job);
  });

  it('creates a pr_context job with its delivery row', async () => {
    const db = fakeDb({ firstValue: null });
    let selectCount = 0;
    const contextJob = { ...job, kind: 'pr_context' };
    db.prepare = (sql) => ({
      bind: (...bindings) => {
        const statement = {
          sql,
          bindings,
          first: vi
            .fn()
            .mockResolvedValue(
              sql.includes('FROM jobs') ? (selectCount++ === 0 ? null : contextJob) : null,
            ),
          run: vi.fn(),
          all: vi.fn(),
        };
        return statement;
      },
    });
    const result = await createPrContextJob(db, {
      deliveryId: 'delivery-1',
      action: 'opened',
      repositoryId: 10,
      repository: { owner: 'owner', name: 'repo', fullName: 'owner/repo' },
      prNumber: 7,
      headSha: 'abc',
    });
    expect(result.created).toBe(true);
    expect(result.job.kind).toBe('pr_context');
    expect(db.batch).toHaveBeenCalledOnce();
  });

  it('creates a pr_summary job reusing the originating delivery', async () => {
    const db = fakeDb({ firstValue: null });
    let selectCount = 0;
    const summaryJob = { ...job, kind: 'pr_summary' };
    db.prepare = (sql) => ({
      bind: (...bindings) => ({
        sql,
        bindings,
        first: vi
          .fn()
          .mockResolvedValue(
            sql.includes('FROM jobs') ? (selectCount++ === 0 ? null : summaryJob) : null,
          ),
        run: vi.fn(),
        all: vi.fn(),
      }),
    });

    const result = await createPrSummaryJob(db, {
      ...job,
      kind: 'pr_context',
      base_sha: 'base',
    });

    expect(result).toMatchObject({ created: true, job: summaryJob });
    expect(db.batch).toHaveBeenCalledOnce();
    const inserts = db.batch.mock.calls[0][0];
    expect(inserts.some((statement) => statement.bindings.includes('pr_summary'))).toBe(true);
    expect(inserts.some((statement) => statement.bindings.includes('delivery-1'))).toBe(true);
  });

  it('sets a lease when claiming a queued job', async () => {
    const db = fakeDb();
    await claimJob(db, 'job-1', '2026-01-01T00:00:00.000Z');
    expect(db.statements[0].sql).toContain('lease_expires_at');
    expect(db.statements[0].bindings).toContain('2026-01-01T00:10:00.000Z');
  });

  it('does not claim an already-running job', async () => {
    const db = fakeDb();
    db.prepare = () => ({
      bind: () => ({ run: vi.fn().mockResolvedValue({ meta: { changes: 0 } }) }),
    });
    await expect(claimJob(db, 'job-1')).resolves.toBeNull();
  });

  it('supports guarded job transitions and outbox operations', async () => {
    const db = fakeDb();
    await expect(claimJob(db, 'job-1')).resolves.toBe(job);
    const runId = await startAnalysisRun(db, 'job-1', 1);
    expect(runId).toEqual(expect.any(String));
    await markJobSucceeded(db, 'job-1', runId);
    await markJobRetryable(db, 'job-1', runId, 'github_unavailable', 10);
    await markJobFailed(db, 'job-1', runId, 'failed');
    await markOutboxPublished(db, 'job-1');
    await recordOutboxFailure(db, 'job-1', 'queue_publish_failed', 10);
    await expect(listDueOutbox(db)).resolves.toEqual([{ job_id: 'job-1' }]);
    expect(db.batch).toHaveBeenCalled();
  });

  it('publishes an outbox job immediately when a producer binding is available', async () => {
    const db = fakeDb();
    const env = { BOT_JOBS: { send: vi.fn().mockResolvedValue(undefined) } };
    await expect(publishOutboxJob(env, db, 'job-1')).resolves.toBe(true);
    expect(env.BOT_JOBS.send).toHaveBeenCalledWith({ schemaVersion: 1, jobId: 'job-1' });
    expect(db.statements.some((statement) => statement.sql.includes('published_at = ?'))).toBe(
      true,
    );
  });

  it('recovers an expired lease by resetting outbox publication', async () => {
    const db = fakeDb({ firstValue: { attempt_count: 1 } });
    db.batch.mockResolvedValue([{ meta: { changes: 1 } }, { meta: { changes: 1 } }]);
    await expect(recoverExpiredJob(db, 'job-1', '2026-01-01T00:00:00.000Z')).resolves.toBe(
      'requeued',
    );
    expect(db.batch).toHaveBeenCalledOnce();
    expect(db.statements.some((statement) => statement.sql.includes('published_at = NULL'))).toBe(
      true,
    );
  });

  it('lists expired running jobs in a bounded batch', async () => {
    const db = fakeDb({ allValue: [{ job_id: 'job-1', attempt_count: 2, kind: 'review' }] });
    await expect(listExpiredRunningJobs(db, 10, '2026-01-01T00:00:00.000Z')).resolves.toEqual([
      { job_id: 'job-1', attempt_count: 2, kind: 'review' },
    ]);
  });

  it('lists stranded due jobs behind the grace cutoff', async () => {
    const row = {
      job_id: 'job-1',
      kind: 'review',
      status: 'retryable',
      available_at: '2026-01-01T00:00:00.000Z',
    };
    const db = fakeDb({ allValue: [row] });
    await expect(listDueStrandedJobs(db, 25, '2026-01-01T00:03:00.000Z')).resolves.toEqual([row]);

    const statement = db.statements.find((s) => s.sql.includes('available_at IS NOT NULL'));
    expect(statement.sql).toContain("status IN ('queued', 'retryable')");
    // The first binding is the cutoff: `now` minus the 120s grace window.
    expect(new Date(statement.bindings[0]).toISOString()).toBe('2026-01-01T00:01:00.000Z');
  });

  it('uses defaults when no repository configuration exists', async () => {
    const cache = { put: vi.fn().mockRejectedValue(new Error('cache down')) };
    await expect(
      getRepositoryConfig(fakeDb({ firstValue: null }), cache, 10),
    ).resolves.toMatchObject({ enabled: true, maxFiles: 100 });
  });

  it('reads, updates, and caches repository configuration', async () => {
    const db = fakeDb({
      firstValue: {
        enabled: 1,
        auto_preview: 1,
        max_files: 20,
        max_context_bytes: 1000,
        retention_profile: 'default',
        version: 2,
      },
    });
    const cache = { put: vi.fn(), delete: vi.fn() };
    await expect(getRepositoryConfig(db, cache, 10)).resolves.toMatchObject({
      maxFiles: 20,
      version: 2,
    });
    await expect(saveRepositoryConfig(db, cache, 10, { maxFiles: 30 })).resolves.toMatchObject({
      maxFiles: 30,
      version: 3,
    });
    expect(cache.put).toHaveBeenCalled();
    expect(cache.delete).toHaveBeenCalled();
    cache.delete.mockRejectedValueOnce(new Error('cache down'));
    await expect(saveRepositoryConfig(db, cache, 10, { maxFiles: 40 })).resolves.toMatchObject({
      maxFiles: 40,
    });
  });
});

describe('marker-scoped comment persistence', () => {
  it('allows only one concurrent publication lease', async () => {
    const db = fakeDb();
    let insertAttempts = 0;
    db.prepare = (sql) => ({
      bind: () => ({
        run: vi.fn().mockResolvedValue({
          meta: { changes: /INSERT/.test(sql) ? (insertAttempts++ === 0 ? 1 : 0) : 0 },
        }),
        first: vi.fn().mockResolvedValue({
          repository_id: 10,
          pr_number: 7,
          comment_kind: 'review',
          github_comment_id: null,
          status: 'publishing',
        }),
      }),
    });
    await expect(
      claimPublication(db, {
        repositoryId: 10,
        prNumber: 7,
        commentKind: 'review',
        marker: '<!-- marker -->',
        jobId: 'job-1',
      }),
    ).resolves.toMatchObject({ status: 'publishing' });
    await expect(
      claimPublication(db, {
        repositoryId: 10,
        prNumber: 7,
        commentKind: 'review',
        marker: '<!-- marker -->',
        jobId: 'job-2',
      }),
    ).resolves.toBeNull();
  });

  it('creates a comment and records its publication', async () => {
    const db = fakeDb({ firstValue: { github_comment_id: null } });
    const github = {
      getIssueComments: vi.fn().mockResolvedValue([]),
      postComment: vi.fn().mockResolvedValue({ id: 99 }),
      updateComment: vi.fn(),
    };
    await expect(
      upsertComment({
        github,
        db,
        owner: 'o',
        repo: 'r',
        issueNumber: 7,
        repositoryId: 10,
        headSha: 'abc',
        commentKind: 'review',
        marker: '<!-- marker -->',
        body: 'body',
        jobId: 'job-1',
      }),
    ).resolves.toMatchObject({ id: 99, created: true });
    expect(github.postComment).toHaveBeenCalledOnce();
  });

  it('updates an existing publication instead of creating a duplicate', async () => {
    const db = fakeDb({ firstValue: { github_comment_id: 99 } });
    const github = {
      getIssueComments: vi
        .fn()
        .mockResolvedValue([
          { id: 99, body: '<!-- marker -->', user: { login: 'bot[bot]', type: 'Bot' } },
        ]),
      updateComment: vi.fn().mockResolvedValue({ id: 99 }),
    };
    await expect(
      upsertComment({
        github,
        db,
        owner: 'o',
        repo: 'r',
        issueNumber: 7,
        repositoryId: 10,
        headSha: 'abc',
        commentKind: 'review',
        marker: '<!-- marker -->',
        body: 'body',
        jobId: 'job-1',
      }),
    ).resolves.toMatchObject({ id: 99, created: false });
    expect(github.updateComment).toHaveBeenCalledWith('o', 'r', 99, 'body');
  });
});

describe('expired-lease recovery paths', () => {
  it('permanently fails a lease that exhausted its attempt budget', async () => {
    const db = fakeDb({ firstValue: { attempt_count: 3 } });
    db.batch.mockResolvedValue([{ meta: { changes: 1 } }, { meta: { changes: 1 } }]);
    await expect(recoverExpiredJob(db, 'job-1', '2026-01-01T00:00:00.000Z')).resolves.toBe(
      'failed',
    );
    expect(db.statements.some((statement) => statement.sql.includes("status = 'failed'"))).toBe(
      true,
    );
  });

  it('returns null when the recovery transaction changed nothing (already recovered)', async () => {
    const db = fakeDb({ firstValue: { attempt_count: 1 } });
    db.batch.mockResolvedValue([{ meta: { changes: 0 } }, { meta: { changes: 0 } }]);
    await expect(recoverExpiredJob(db, 'job-1', '2026-01-01T00:00:00.000Z')).resolves.toBeNull();
  });

  it('returns null when the job is no longer in an expired running state', async () => {
    const db = fakeDb({ firstValue: null });
    await expect(recoverExpiredJob(db, 'job-1', '2026-01-01T00:00:00.000Z')).resolves.toBeNull();
    expect(db.batch).not.toHaveBeenCalled();
  });

  it('links a result artifact to its analysis run', async () => {
    const db = fakeDb();
    await linkRunResultArtifact(db, 'run-1', 'artifact-9');
    expect(db.statements[0].sql).toContain('result_artifact_id');
    expect(db.statements[0].bindings).toContain('artifact-9');
  });
});

describe('isBotOwnedComment', () => {
  const comment = (over = {}) => ({
    id: 1,
    body: 'text',
    user: { login: 'u', type: 'User' },
    ...over,
  });

  it('rejects null comments and non-string bodies', () => {
    expect(isBotOwnedComment(null)).toBe(false);
    expect(isBotOwnedComment({ id: 1, body: 42 })).toBe(false);
  });

  it('accepts the tracked comment id unconditionally', () => {
    expect(
      isBotOwnedComment(comment({ user: { login: 'someone-else', type: 'User' } }), {
        expectedCommentId: 1,
      }),
    ).toBe(true);
  });

  it('accepts GitHub App comments', () => {
    expect(isBotOwnedComment(comment({ user: { login: 'app[bot]', type: 'Bot' } }))).toBe(true);
  });

  it('matches a configured PAT login only when exact', () => {
    expect(isBotOwnedComment(comment(), { botLogin: 'u' })).toBe(true);
    expect(isBotOwnedComment(comment(), { botLogin: 'other' })).toBe(false);
    // Without a botLogin, a plain User comment is never bot-owned.
    expect(isBotOwnedComment(comment())).toBe(false);
  });
});

describe('comment publication edge paths', () => {
  /** db stub keyed on SQL shape: INSERT = claim, UPDATE = finalize, first = publication row. */
  function publicationDb({ claimChanges = 1, finalizeChanges = 1, publication = {} } = {}) {
    return {
      prepare: vi.fn((sql) => ({
        bind: () => ({
          run: vi.fn().mockResolvedValue({
            meta: { changes: /INSERT/.test(sql) ? claimChanges : finalizeChanges },
          }),
          first: vi.fn().mockResolvedValue(publication),
        }),
      })),
    };
  }

  const args = (overrides = {}) => ({
    github: {
      getIssueComments: vi.fn().mockResolvedValue([]),
      postComment: vi.fn().mockResolvedValue({ id: 9 }),
      // Echo the updated comment id so assertions can verify WHICH comment was updated.
      updateComment: vi.fn((_owner, _repo, commentId) => Promise.resolve({ id: commentId })),
    },
    db: publicationDb(),
    owner: 'o',
    repo: 'r',
    issueNumber: 7,
    repositoryId: 10,
    headSha: 'abc',
    commentKind: 'review',
    marker: '<!-- marker -->',
    body: 'body',
    jobId: 'job-1',
    ...overrides,
  });

  it('requires a job id so every publication is lease-tracked', async () => {
    const { jobId: _omitted, ...rest } = args();
    await expect(upsertComment(rest)).rejects.toThrow('job ID is required');
  });

  it('skips publication when the lease is held by another job', async () => {
    const input = args({
      db: publicationDb({ claimChanges: 0, publication: { github_comment_id: 42 } }),
      waitMs: 0,
    });
    await expect(upsertComment(input)).resolves.toEqual({
      id: 42,
      created: false,
      skipped: true,
      attempts: 1,
    });
    expect(input.github.postComment).not.toHaveBeenCalled();
  });

  it('reports a null id when no publication row exists at all', async () => {
    const input = args({
      db: publicationDb({ claimChanges: 0, publication: null }),
      waitMs: 0,
    });
    await expect(upsertComment(input)).resolves.toEqual({
      id: null,
      created: false,
      skipped: true,
      attempts: 1,
    });
  });

  it('waits out a concurrent lease and publishes once the winner finalizes', async () => {
    const publicationRow = { github_comment_id: 55, status: 'published' };
    const claimRuns = [];
    const db = {
      prepare: vi.fn((sql) => ({
        bind: () => ({
          run: vi.fn().mockImplementation(async () => {
            // First INSERT (claim) loses the lease; the re-claim after the
            // poll wins. Finalize (UPDATE) always succeeds.
            if (/INSERT/.test(sql)) {
              claimRuns.push(1);
              return { meta: { changes: claimRuns.length > 1 ? 1 : 0 } };
            }
            return { meta: { changes: 1 } };
          }),
          first: vi.fn().mockResolvedValue(publicationRow),
        }),
      })),
    };
    const github = {
      getIssueComments: vi
        .fn()
        .mockResolvedValue([
          { id: 55, body: '<!-- marker -->', user: { login: 'bot[bot]', type: 'Bot' } },
        ]),
      updateComment: vi
        .fn()
        .mockImplementation((_o, _r, commentId) => Promise.resolve({ id: commentId })),
    };

    const out = await upsertComment({
      github,
      db,
      owner: 'o',
      repo: 'r',
      issueNumber: 7,
      repositoryId: 10,
      headSha: 'abc',
      commentKind: 'review',
      marker: '<!-- marker -->',
      body: 'body',
      jobId: 'job-2',
      waitMs: 200,
      pollMs: 10,
    });

    expect(out).toMatchObject({ id: 55, created: false, skipped: false });
    expect(out.attempts).toBeGreaterThanOrEqual(2);
    expect(github.updateComment).toHaveBeenCalledWith('o', 'r', 55, 'body');
  });

  it('posts a fresh comment when the marker comment id differs from the publication record', async () => {
    const input = args({
      db: publicationDb({ publication: { github_comment_id: 99 } }),
    });
    input.github.getIssueComments.mockResolvedValue([
      { id: 77, body: '<!-- marker -->', user: { login: 'bot[bot]', type: 'Bot' } },
    ]);
    await expect(upsertComment(input)).resolves.toMatchObject({ id: 9, created: true });
    expect(input.github.postComment).toHaveBeenCalledOnce();
    expect(input.github.updateComment).not.toHaveBeenCalled();
  });

  it('matches a PAT-owned bot comment through the configured botLogin', async () => {
    const input = args({ botLogin: 'zai-bot' });
    input.github.getIssueComments.mockResolvedValue([
      { id: 5, body: '<!-- marker -->', user: { login: 'zai-bot', type: 'User' } },
    ]);
    await expect(upsertComment(input)).resolves.toMatchObject({ id: 5, created: false });
    expect(input.github.updateComment).toHaveBeenCalledWith('o', 'r', 5, 'body');
  });

  it('scans subsequent pages when the marker comment is not on page one', async () => {
    const input = args();
    const filler = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      body: 'regular review chatter',
      user: { login: 'someone', type: 'User' },
    }));
    input.github.getIssueComments
      .mockResolvedValueOnce(filler)
      .mockResolvedValueOnce([
        { id: 300, body: '<!-- marker -->', user: { login: 'bot[bot]', type: 'Bot' } },
      ]);
    await expect(upsertComment(input)).resolves.toMatchObject({ id: 300, created: false });
    expect(input.github.getIssueComments).toHaveBeenNthCalledWith(1, 'o', 'r', 7, 1, 100);
    expect(input.github.getIssueComments).toHaveBeenNthCalledWith(2, 'o', 'r', 7, 2, 100);
  });

  it('treats a non-array comment response as no match and posts a new comment', async () => {
    const input = args();
    input.github.getIssueComments.mockResolvedValue(null);
    await expect(upsertComment(input)).resolves.toMatchObject({ id: 9, created: true });
    expect(input.github.postComment).toHaveBeenCalledOnce();
  });

  it('throws when the publication lease is lost before finalize', async () => {
    const input = args({ db: publicationDb({ finalizeChanges: 0 }) });
    await expect(upsertComment(input)).rejects.toThrow('lease was lost');
    expect(input.github.postComment).toHaveBeenCalledOnce();
  });
});

describe('storage sweep edges', () => {
  it('clamps invalid list limits to one and tolerates missing results', async () => {
    const empty = fakeDb({ allValue: null });
    await expect(listExpiredRunningJobs(empty, 'x')).resolves.toEqual([]);
    await expect(listDueOutbox(empty, 0)).resolves.toEqual([]);
    await expect(listDueStrandedJobs(empty, NaN)).resolves.toEqual([]);

    const db = fakeDb({ allValue: [{ job_id: 'job-1' }] });
    await listExpiredRunningJobs(db, 'x');
    expect(db.statements[0].bindings[1]).toBe(1);
  });

  it('skips outbox publishing without a producer binding', async () => {
    const db = fakeDb();
    await expect(publishOutboxJob({}, db, 'job-1')).resolves.toBe(false);
    await expect(publishOutboxJob(null, db, 'job-1')).resolves.toBe(false);
  });

  it('rejects non-positive repository and PR identifiers', async () => {
    const db = fakeDb();
    const base = {
      deliveryId: 'd-1',
      kind: 'pr_context',
      repository: { owner: 'owner', name: 'repo', fullName: 'owner/repo' },
    };
    for (const bad of [
      { ...base, repositoryId: 'x', prNumber: 7 },
      { ...base, repositoryId: 0, prNumber: 7 },
      { ...base, repositoryId: 10, prNumber: -1 },
    ]) {
      await expect(createPrContextJob(db, bad)).rejects.toThrow(TypeError);
    }
  });

  it('returns the concurrent winner when the insert loses a UNIQUE race', async () => {
    let selectCount = 0;
    const db = fakeDb({ firstValue: null });
    db.prepare = (sql) => ({
      bind: (...bindings) => {
        const statement = {
          sql,
          bindings,
          first: vi
            .fn()
            .mockResolvedValue(
              sql.includes('FROM jobs') ? (selectCount++ === 0 ? null : job) : null,
            ),
          run: vi.fn(),
          all: vi.fn(),
        };
        return statement;
      },
    });
    db.batch = vi.fn().mockRejectedValue(new Error('UNIQUE constraint failed'));
    const event = validEvent();
    await expect(createPrContextJob(db, event)).resolves.toMatchObject({
      job: expect.objectContaining({ job_id: 'job-1' }),
      created: false,
    });
  });

  it('rethrows when a lost UNIQUE race has no winner to read', async () => {
    const db = fakeDb({ firstValue: null });
    db.batch.mockRejectedValue(new Error('UNIQUE constraint failed'));
    await expect(createPrContextJob(db, validEvent('d-race'))).rejects.toThrow(
      'UNIQUE constraint failed',
    );
  });

  it('fails loudly when a created job cannot be read back', async () => {
    const db = fakeDb({ firstValue: null });
    await expect(createPrContextJob(db, validEvent('d-load'))).rejects.toThrow(
      'could not be loaded',
    );
  });

  it('creates command jobs owning their delivery row', async () => {
    let selectCount = 0;
    const db = fakeDb({ firstValue: null });
    db.prepare = (sql) => ({
      bind: (...bindings) => {
        const statement = {
          sql,
          bindings,
          first: vi
            .fn()
            .mockResolvedValue(
              sql.includes('FROM jobs') ? (selectCount++ === 0 ? null : job) : null,
            ),
          run: vi.fn(),
          all: vi.fn(),
        };
        return statement;
      },
    });
    await expect(createCommandJob(db, validEvent('d-cmd'), 'review')).resolves.toMatchObject({
      job: expect.objectContaining({ job_id: 'job-1' }),
      created: true,
    });
  });

  it('looks up deliveries with and without a kind', async () => {
    const db = fakeDb();
    await getJobByDelivery(db, 'd-1', 'review');
    expect(db.statements[0].sql).toContain('WHERE j.delivery_id = ? AND j.kind = ?');
    await getJobByDelivery(db, 'd-1');
    // The kind filter lives in the WHERE clause; the shared SELECT list always
    // mentions j.kind as a column.
    expect(db.statements[1].sql).toContain('WHERE j.delivery_id = ?');
    expect(db.statements[1].sql.match(/WHERE j\.delivery_id = \? AND/g)?.length ?? 0).toBe(0);
  });

  it('rejects non-string PR heads and unconfigured databases', async () => {
    const db = fakeDb({ firstValue: { head_sha: 42 } });
    await expect(getCurrentPullRequestHead(db, 10, 7)).resolves.toBeNull();
    await expect(getCurrentPullRequestHead({}, 10, 7)).resolves.toBeNull();
  });

  it('reads changed rows and bindings defensively', () => {
    expect(changedRows({ changes: 3 })).toBe(3);
    expect(changedRows(null)).toBe(0);
    expect(requireBinding('binding', 'BOT_DB')).toBe('binding');
    expect(() => requireBinding(null, 'BOT_DB')).toThrow('BOT_DB binding is not configured');
  });

  it('returns the raw result object when no meta wrapper exists', async () => {
    const stmt = {
      run: vi.fn().mockResolvedValueOnce({ foo: 1 }).mockResolvedValueOnce(null),
      all: vi.fn(),
      first: vi.fn(),
    };
    await expect(run(stmt)).resolves.toEqual({ foo: 1 });
    await expect(run(stmt)).resolves.toEqual({});
  });
});
