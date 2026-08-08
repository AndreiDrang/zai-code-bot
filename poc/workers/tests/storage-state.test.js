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
import { createPrPreviewJob, createPrContextJob, getJob } from '../shared/storage/deliveries.js';
import { getRepositoryConfig, saveRepositoryConfig } from '../shared/storage/config.js';
import {
  claimJob,
  listDueOutbox,
  listExpiredRunningJobs,
  recoverExpiredJob,
  markJobFailed,
  markJobRetryable,
  markJobSucceeded,
  markOutboxPublished,
  recordOutboxFailure,
  startAnalysisRun,
} from '../shared/storage/jobs.js';
import { claimPublication, upsertComment } from '../shared/comments.js';

const job = {
  job_id: 'job-1',
  delivery_id: 'delivery-1',
  kind: 'pr_preview',
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
      createPrPreviewJob(db, {
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
    await expect(createPrPreviewJob(fakeDb(), { deliveryId: 'only-id' })).rejects.toThrow(
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
    const result = await createPrPreviewJob(db, {
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

  it('creates a pr_context job reusing the delivery row', async () => {
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
    const db = fakeDb({ allValue: [{ job_id: 'job-1', attempt_count: 2, kind: 'pr_preview' }] });
    await expect(listExpiredRunningJobs(db, 10, '2026-01-01T00:00:00.000Z')).resolves.toEqual([
      { job_id: 'job-1', attempt_count: 2, kind: 'pr_preview' },
    ]);
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
          comment_kind: 'pr_preview',
          github_comment_id: null,
          status: 'publishing',
        }),
      }),
    });
    await expect(
      claimPublication(db, {
        repositoryId: 10,
        prNumber: 7,
        commentKind: 'pr_preview',
        marker: '<!-- marker -->',
        jobId: 'job-1',
      }),
    ).resolves.toMatchObject({ status: 'publishing' });
    await expect(
      claimPublication(db, {
        repositoryId: 10,
        prNumber: 7,
        commentKind: 'pr_preview',
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
        commentKind: 'pr_preview',
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
        commentKind: 'pr_preview',
        marker: '<!-- marker -->',
        body: 'body',
        jobId: 'job-1',
      }),
    ).resolves.toMatchObject({ id: 99, created: false });
    expect(github.updateComment).toHaveBeenCalledWith('o', 'r', 99, 'body');
  });
});
