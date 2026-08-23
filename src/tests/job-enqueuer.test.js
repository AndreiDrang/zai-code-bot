import { beforeEach, describe, expect, it, vi } from 'vitest';

// Unit tests for the main worker's queue-producer / recovery helpers.
//
// The D1 + R2 storage layer is mocked (same pattern as queue.test.js) so these
// tests pin the ORCHESTRATION contract: outbox write-around, lease recovery
// counting, bounded outbox replay, and the R2 sweep delegation.

vi.mock('../shared/storage/jobs.js', () => ({
  queueMessage: vi.fn(),
  markOutboxPublished: vi.fn(),
  recordOutboxFailure: vi.fn(),
  listDueOutbox: vi.fn(),
  listDueStrandedJobs: vi.fn(),
  listExpiredRunningJobs: vi.fn(),
  recoverExpiredJob: vi.fn(),
}));
vi.mock('../shared/storage/database.js', () => ({
  safeErrorCode: vi.fn((_error, fallback) => fallback),
}));
vi.mock('../shared/storage/artifacts.js', () => ({
  deleteExpiredArtifacts: vi.fn(),
}));
vi.mock('../shared/logging.js', () => ({
  createLogger: vi.fn(() => logger),
}));

import {
  enqueueJob,
  recoverExpiredJobs,
  replayDueOutbox,
  requeueStrandedJobs,
  sweepExpiredStorage,
} from '../zai-main-worker/src/job-enqueuer.js';
import {
  queueMessage,
  markOutboxPublished,
  recordOutboxFailure,
  listDueOutbox,
  listDueStrandedJobs,
  listExpiredRunningJobs,
  recoverExpiredJob,
} from '../shared/storage/jobs.js';
import { deleteExpiredArtifacts } from '../shared/storage/artifacts.js';

const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };

const db = { __db: true };
// R2 bucket stub — must expose `delete` (the sweep guard checks for it).
const bucket = { delete: vi.fn() };

function makeEnv(overrides = {}) {
  return {
    BOT_DB: db,
    BOT_JOBS: { send: vi.fn() },
    BOT_ARTIFACTS: bucket,
    ...overrides,
  };
}

describe('enqueueJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queueMessage.mockImplementation((jobId) => ({ schemaVersion: 1, jobId }));
  });

  it('throws when the queue binding is not configured', async () => {
    const env = makeEnv({ BOT_JOBS: undefined });
    await expect(enqueueJob(env, 'job-1')).rejects.toThrow(
      'BOT_JOBS queue binding is not configured',
    );
    expect(markOutboxPublished).not.toHaveBeenCalled();
  });

  it('sends the queue message and marks the outbox row published', async () => {
    const env = makeEnv();
    env.BOT_JOBS.send.mockResolvedValue(undefined);
    markOutboxPublished.mockResolvedValue(undefined);

    await expect(enqueueJob(env, 'job-1')).resolves.toBe(true);

    expect(env.BOT_JOBS.send).toHaveBeenCalledTimes(1);
    expect(env.BOT_JOBS.send).toHaveBeenCalledWith({ schemaVersion: 1, jobId: 'job-1' });
    expect(markOutboxPublished).toHaveBeenCalledWith(db, 'job-1');
    expect(recordOutboxFailure).not.toHaveBeenCalled();
  });

  it('records an outbox failure with the 30s retry delay and rethrows', async () => {
    const env = makeEnv();
    const failure = new Error('queue unavailable');
    env.BOT_JOBS.send.mockRejectedValue(failure);
    recordOutboxFailure.mockResolvedValue(undefined);

    await expect(enqueueJob(env, 'job-1')).rejects.toThrow('queue unavailable');

    expect(recordOutboxFailure).toHaveBeenCalledTimes(1);
    expect(recordOutboxFailure).toHaveBeenCalledWith(db, 'job-1', 'queue_publish_failed', 30);
    expect(markOutboxPublished).not.toHaveBeenCalled();
  });
});

describe('recoverExpiredJobs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('counts requeued and permanently-failed leases and logs each', async () => {
    listExpiredRunningJobs.mockResolvedValue([
      { job_id: 'job-a', kind: 'review', attempt_count: 1 },
      { job_id: 'job-b', kind: 'describe', attempt_count: 3 },
    ]);
    recoverExpiredJob.mockImplementation(async (_db, jobId) =>
      jobId === 'job-a' ? 'requeued' : 'failed',
    );

    const result = await recoverExpiredJobs(makeEnv(), 100);

    expect(result).toEqual({ found: 2, requeued: 1, failed: 1 });
    expect(recoverExpiredJob).toHaveBeenCalledWith(db, 'job-a');
    expect(recoverExpiredJob).toHaveBeenCalledWith(db, 'job-b');
    expect(logger.warn).toHaveBeenCalledWith(
      'Expired job lease requeued',
      expect.objectContaining({ jobId: 'job-a', errorCode: 'worker_lease_expired' }),
    );
    expect(logger.error).toHaveBeenCalledWith(
      'Expired job operation_failed',
      expect.objectContaining({ jobId: 'job-b', errorCode: 'operation_failed' }),
    );
  });

  it('does not count rows that no longer qualify for recovery', async () => {
    listExpiredRunningJobs.mockResolvedValue([
      { job_id: 'job-a', kind: 'review', attempt_count: 1 },
    ]);
    recoverExpiredJob.mockResolvedValue(null);

    const result = await recoverExpiredJobs(makeEnv(), 100);

    expect(result).toEqual({ found: 1, requeued: 0, failed: 0 });
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('reports zeros when nothing is expired', async () => {
    listExpiredRunningJobs.mockResolvedValue([]);

    const result = await recoverExpiredJobs(makeEnv(), 100);

    expect(result).toEqual({ found: 0, requeued: 0, failed: 0 });
    expect(recoverExpiredJob).not.toHaveBeenCalled();
  });
});

describe('replayDueOutbox', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queueMessage.mockImplementation((jobId) => ({ schemaVersion: 1, jobId }));
    markOutboxPublished.mockResolvedValue(undefined);
    recordOutboxFailure.mockResolvedValue(undefined);
  });

  it('replays every due row', async () => {
    const env = makeEnv();
    env.BOT_JOBS.send.mockResolvedValue(undefined);
    listDueOutbox.mockResolvedValue([{ job_id: 'job-a' }, { job_id: 'job-b' }]);

    const result = await replayDueOutbox(env, 25);

    expect(result).toEqual({ found: 2, published: 2 });
    expect(markOutboxPublished).toHaveBeenCalledWith(db, 'job-a');
    expect(markOutboxPublished).toHaveBeenCalledWith(db, 'job-b');
  });

  it('keeps processing the batch when one publish fails', async () => {
    const env = makeEnv();
    env.BOT_JOBS.send
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce(undefined);
    listDueOutbox.mockResolvedValue([
      { job_id: 'job-a' },
      { job_id: 'job-b' },
      { job_id: 'job-c' },
    ]);

    const result = await replayDueOutbox(env, 25);

    expect(result).toEqual({ found: 3, published: 2 });
    expect(recordOutboxFailure).toHaveBeenCalledWith(db, 'job-b', 'queue_publish_failed', 30);
    expect(markOutboxPublished).not.toHaveBeenCalledWith(db, 'job-b');
  });
});

describe('requeueStrandedJobs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queueMessage.mockImplementation((jobId) => ({ schemaVersion: 1, jobId }));
  });

  it('skips without counting when bindings are missing', async () => {
    const result = await requeueStrandedJobs(makeEnv({ BOT_JOBS: undefined }));

    expect(result).toEqual({ found: 0, requeued: 0, skipped: true });
    expect(listDueStrandedJobs).not.toHaveBeenCalled();
  });

  it('re-sends a message for each stranded row without touching the outbox', async () => {
    const env = makeEnv();
    env.BOT_JOBS.send.mockResolvedValue(undefined);
    listDueStrandedJobs.mockResolvedValue([
      { job_id: 'job-a', kind: 'review', status: 'retryable', available_at: 'x' },
      { job_id: 'job-b', kind: 'describe', status: 'queued', available_at: 'y' },
    ]);

    const result = await requeueStrandedJobs(env, 25);

    expect(result).toEqual({ found: 2, requeued: 2 });
    expect(env.BOT_JOBS.send).toHaveBeenCalledWith({ schemaVersion: 1, jobId: 'job-a' });
    expect(env.BOT_JOBS.send).toHaveBeenCalledWith({ schemaVersion: 1, jobId: 'job-b' });
    // The outbox row tracks FIRST publication only — already published, so
    // the sweep must not re-mark it or double-count publish attempts.
    expect(markOutboxPublished).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      'Stranded due job re-enqueued',
      expect.objectContaining({ jobId: 'job-a', errorCode: 'stranded_job_requeued' }),
    );
  });

  it('keeps processing the batch when one send fails', async () => {
    const env = makeEnv();
    env.BOT_JOBS.send
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce(undefined);
    listDueStrandedJobs.mockResolvedValue([{ job_id: 'job-a' }, { job_id: 'job-b' }]);

    const result = await requeueStrandedJobs(env, 25);

    expect(result).toEqual({ found: 2, requeued: 1 });
  });
});

describe('sweepExpiredStorage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips without counting when the R2 binding is missing', async () => {
    const result = await sweepExpiredStorage(makeEnv({ BOT_ARTIFACTS: undefined }));

    expect(result).toEqual({ found: 0, deleted: 0, skipped: true });
    expect(deleteExpiredArtifacts).not.toHaveBeenCalled();
  });

  it('delegates to deleteExpiredArtifacts with db, bucket, and limit', async () => {
    deleteExpiredArtifacts.mockResolvedValue({ found: 3, deleted: 2 });

    await expect(sweepExpiredStorage(makeEnv(), 100)).resolves.toEqual({ found: 3, deleted: 2 });
    expect(deleteExpiredArtifacts).toHaveBeenCalledWith({ db, bucket, limit: 100 });
  });
});
