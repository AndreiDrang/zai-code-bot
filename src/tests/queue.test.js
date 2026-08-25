import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../shared/storage/deliveries.js', () => ({
  getJob: vi.fn(),
}));
vi.mock('../shared/storage/jobs.js', () => ({
  MAX_JOB_ATTEMPTS: 3,
  claimJob: vi.fn(),
  markJobFailed: vi.fn(),
  markJobRetryable: vi.fn(),
  markJobSucceeded: vi.fn(),
  startAnalysisRun: vi.fn(),
}));
vi.mock('../zai-heavy-worker/src/handlers/index.js', () => ({
  getHeavyHandler: vi.fn(),
}));
vi.mock('../shared/github.js', () => ({ GitHubClient: vi.fn() }));
vi.mock('../shared/github-app-auth.js', () => ({ createTokenProvider: vi.fn() }));

import { getHeavyHandler } from '../zai-heavy-worker/src/handlers/index.js';
import { processQueueMessage } from '../zai-heavy-worker/src/queue.js';
import { getJob } from '../shared/storage/deliveries.js';
import { GitHubClient } from '../shared/github.js';
import { createTokenProvider } from '../shared/github-app-auth.js';
import {
  claimJob,
  markJobFailed,
  markJobRetryable,
  markJobSucceeded,
  startAnalysisRun,
} from '../shared/storage/jobs.js';

const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };

function message() {
  return { body: { schemaVersion: 1, jobId: 'job-1' }, ack: vi.fn(), retry: vi.fn() };
}

function claimed(attempt_count = 1) {
  return {
    job_id: 'job-1',
    kind: 'review',
    attempt_count,
    installation_id: 456,
    repository_owner: 'owner',
    repository_name: 'repo',
    pr_number: 1,
  };
}

describe('heavy worker queue protocol', () => {
  let mintToken;

  beforeEach(() => {
    vi.clearAllMocks();
    getHeavyHandler.mockReturnValue(vi.fn().mockResolvedValue({ status: 'success' }));
    startAnalysisRun.mockResolvedValue('run-1');
    markJobRetryable.mockResolvedValue(undefined);
    markJobFailed.mockResolvedValue(undefined);
    markJobSucceeded.mockResolvedValue(undefined);
    // App token provider: available by default, minting a fixed token.
    mintToken = vi.fn().mockResolvedValue('ghs_test');
    createTokenProvider.mockResolvedValue({ available: true, getInstallationToken: mintToken });
    GitHubClient.mockImplementation(
      class {
        constructor(token) {
          this.token = token;
        }
      },
    );
  });

  it('acks malformed messages without touching storage', async () => {
    const msg = { body: { schemaVersion: 99 }, ack: vi.fn(), retry: vi.fn() };
    await processQueueMessage(msg, {}, logger);
    expect(msg.ack).toHaveBeenCalledOnce();
    expect(msg.retry).not.toHaveBeenCalled();
    expect(getJob).not.toHaveBeenCalled();
  });

  it('acks a message whose job no longer exists', async () => {
    getJob.mockResolvedValue(null);
    const msg = message();
    await processQueueMessage(msg, { BOT_DB: {} }, logger);
    expect(msg.ack).toHaveBeenCalledOnce();
  });

  it('re-delays a claim-null redelivery that arrived before available_at', async () => {
    const availableAt = new Date(Date.now() + 45_000).toISOString();
    getJob.mockResolvedValue({ ...claimed(), status: 'retryable', available_at: availableAt });
    claimJob.mockResolvedValue(null);
    const msg = message();

    await processQueueMessage(msg, { BOT_DB: {} }, logger);

    expect(msg.retry).toHaveBeenCalledWith({ delaySeconds: expect.any(Number) });
    const { delaySeconds } = msg.retry.mock.calls[0][0];
    expect(delaySeconds).toBeGreaterThanOrEqual(1);
    expect(delaySeconds).toBeLessThanOrEqual(45);
    expect(msg.ack).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      'Redelivery preceded available_at; re-delayed',
      expect.objectContaining({ jobId: 'job-1', status: 'retryable' }),
    );
  });

  it('acks a claim-null redelivery for a job that is already due', async () => {
    getJob.mockResolvedValue({
      ...claimed(),
      status: 'retryable',
      available_at: '2020-01-01T00:00:00.000Z',
    });
    claimJob.mockResolvedValue(null);
    const msg = message();

    await processQueueMessage(msg, { BOT_DB: {} }, logger);

    expect(msg.ack).toHaveBeenCalledOnce();
    expect(msg.retry).not.toHaveBeenCalled();
  });

  it('acks a claim-null redelivery for running or completed jobs', async () => {
    for (const status of ['running', 'succeeded', 'failed']) {
      const msg = message();
      getJob.mockResolvedValue({
        ...claimed(),
        status,
        available_at: new Date(Date.now() + 60_000).toISOString(),
      });
      claimJob.mockResolvedValue(null);
      await processQueueMessage(msg, { BOT_DB: {} }, logger);
      expect(msg.ack).toHaveBeenCalledOnce();
      expect(msg.retry).not.toHaveBeenCalled();
    }
  });

  it('retries the first transient failure and emits a warning', async () => {
    getJob.mockResolvedValue(claimed());
    claimJob.mockResolvedValue(claimed(1));
    getHeavyHandler.mockReturnValue(
      vi.fn().mockRejectedValue(Object.assign(new Error('unavailable'), { status: 503 })),
    );
    const msg = message();

    await processQueueMessage(msg, { BOT_DB: {} }, logger);

    expect(markJobRetryable).toHaveBeenCalledWith({}, 'job-1', 'run-1', 'github_unavailable', 20);
    expect(msg.retry).toHaveBeenCalledWith({ delaySeconds: 20 });
    expect(msg.ack).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      'Queue job scheduled for retry',
      expect.objectContaining({ attempt: 1, errorCode: 'github_unavailable' }),
    );
  });

  it('retries a typed transient LLM failure without converting its error code', async () => {
    getJob.mockResolvedValue(claimed());
    claimJob.mockResolvedValue(claimed(1));
    getHeavyHandler.mockReturnValue(
      vi.fn().mockRejectedValue(
        Object.assign(new Error('LLM command failed: timeout'), {
          code: 'llm_timeout',
          retryable: true,
        }),
      ),
    );
    const msg = message();

    await processQueueMessage(msg, { BOT_DB: {} }, logger);

    expect(markJobRetryable).toHaveBeenCalledWith({}, 'job-1', 'run-1', 'llm_timeout', 20);
    expect(msg.retry).toHaveBeenCalledWith({ delaySeconds: 20 });
  });

  it('marks the third failure failed, logs an error, and acknowledges it', async () => {
    getJob.mockResolvedValue(claimed(2));
    claimJob.mockResolvedValue(claimed(3));
    getHeavyHandler.mockReturnValue(vi.fn().mockRejectedValue(new Error('permanent')));
    const msg = message();

    await processQueueMessage(msg, { BOT_DB: {} }, logger);

    expect(markJobFailed).toHaveBeenCalledWith({}, 'job-1', 'run-1', 'operation_failed');
    expect(msg.ack).toHaveBeenCalledOnce();
    expect(msg.retry).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      'Queue job operation_failed',
      expect.objectContaining({ attempt: 3 }),
    );
  });

  it('recovers a failure before analysis run creation', async () => {
    getJob.mockResolvedValue(claimed());
    claimJob.mockResolvedValue(claimed(1));
    startAnalysisRun.mockRejectedValue(new Error('D1 unavailable'));
    const msg = message();

    await processQueueMessage(msg, { BOT_DB: {} }, logger);

    expect(markJobRetryable).toHaveBeenCalledWith({}, 'job-1', null, 'job_failed', 20);
    expect(msg.retry).toHaveBeenCalledWith({ delaySeconds: 20 });
  });
});

describe('heavy worker queue GitHub App authentication', () => {
  let mintToken;

  beforeEach(() => {
    vi.clearAllMocks();
    startAnalysisRun.mockResolvedValue('run-1');
    markJobRetryable.mockResolvedValue(undefined);
    markJobFailed.mockResolvedValue(undefined);
    markJobSucceeded.mockResolvedValue(undefined);
    mintToken = vi.fn().mockResolvedValue('ghs_test');
    createTokenProvider.mockResolvedValue({ available: true, getInstallationToken: mintToken });
    GitHubClient.mockImplementation(
      class {
        constructor(token) {
          this.token = token;
        }
      },
    );
  });

  it('authenticates the handler client as the App installation', async () => {
    getJob.mockResolvedValue(claimed());
    claimJob.mockResolvedValue(claimed(1));
    const handler = vi.fn().mockResolvedValue({ status: 'success' });
    getHeavyHandler.mockReturnValue(handler);
    const msg = message();

    await processQueueMessage(msg, { BOT_DB: {} }, logger);

    expect(mintToken).toHaveBeenCalledWith(456);
    expect(GitHubClient).toHaveBeenCalledWith('ghs_test');
    const handlerArg = handler.mock.calls[0][0];
    expect(handlerArg.github).toBeInstanceOf(Object);
    expect(handlerArg.github.token).toBe('ghs_test');
    expect(markJobSucceeded).toHaveBeenCalledWith({}, 'job-1', 'run-1');
    expect(msg.ack).toHaveBeenCalledOnce();
  });

  it('fails a legacy job without installation_id instead of retrying it', async () => {
    const legacy = { ...claimed(), installation_id: null };
    getJob.mockResolvedValue(legacy);
    claimJob.mockResolvedValue(legacy);
    const handler = vi.fn();
    getHeavyHandler.mockReturnValue(handler);
    const msg = message();

    await processQueueMessage(msg, { BOT_DB: {} }, logger);

    expect(handler).not.toHaveBeenCalled();
    expect(mintToken).not.toHaveBeenCalled();
    expect(markJobFailed).toHaveBeenCalledWith({}, 'job-1', 'run-1', 'operation_failed');
    expect(msg.ack).toHaveBeenCalledOnce();
    expect(msg.retry).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      'Queue job operation_failed',
      expect.objectContaining({ causeCode: 'missing_installation_id' }),
    );
  });

  it('fails the job when App credentials are not configured', async () => {
    createTokenProvider.mockResolvedValue({ available: false, getInstallationToken: vi.fn() });
    getJob.mockResolvedValue(claimed());
    claimJob.mockResolvedValue(claimed(1));
    const msg = message();

    await processQueueMessage(msg, { BOT_DB: {} }, logger);

    expect(markJobFailed).toHaveBeenCalledWith({}, 'job-1', 'run-1', 'operation_failed');
    expect(msg.ack).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith(
      'Queue job operation_failed',
      expect.objectContaining({ causeCode: 'app_auth_unconfigured' }),
    );
  });

  it('retries a transient mint failure with backoff', async () => {
    mintToken.mockRejectedValue(
      Object.assign(new Error('GitHub token endpoint returned 500'), {
        code: 'app_token_fetch_failed',
        retryable: true,
      }),
    );
    getJob.mockResolvedValue(claimed());
    claimJob.mockResolvedValue(claimed(1));
    const msg = message();

    await processQueueMessage(msg, { BOT_DB: {} }, logger);

    expect(markJobRetryable).toHaveBeenCalledWith(
      {},
      'job-1',
      'run-1',
      'app_token_fetch_failed',
      20,
    );
    expect(msg.retry).toHaveBeenCalledWith({ delaySeconds: 20 });
    expect(msg.ack).not.toHaveBeenCalled();
  });

  it('fails the job when the app JWT is rejected (401)', async () => {
    mintToken.mockRejectedValue(
      Object.assign(new Error('GitHub rejected the app JWT'), {
        code: 'app_jwt_rejected',
        retryable: false,
      }),
    );
    getJob.mockResolvedValue(claimed());
    claimJob.mockResolvedValue(claimed(1));
    const msg = message();

    await processQueueMessage(msg, { BOT_DB: {} }, logger);

    expect(markJobFailed).toHaveBeenCalledWith({}, 'job-1', 'run-1', 'operation_failed');
    expect(msg.ack).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith(
      'Queue job operation_failed',
      expect.objectContaining({ causeCode: 'app_jwt_rejected' }),
    );
  });
});
