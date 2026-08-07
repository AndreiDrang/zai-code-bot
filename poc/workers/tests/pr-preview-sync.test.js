import { beforeEach, describe, expect, it, vi } from 'vitest';

// --- Mock the storage / I/O collaborators so we can exercise the handler in
// isolation and assert on the publication decision (update vs create). ---
vi.mock('../shared/storage/config.js', () => ({
  getRepositoryConfig: vi.fn(),
}));
vi.mock('../shared/storage/artifacts.js', () => ({
  artifactExpiresAt: vi.fn().mockReturnValue('2099-01-01T00:00:00.000Z'),
  writeArtifact: vi.fn().mockResolvedValue({ artifactId: 'art-1' }),
}));
vi.mock('../shared/storage/jobs.js', () => ({
  linkRunResultArtifact: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../shared/comments.js', () => ({
  upsertComment: vi.fn(),
}));

import { PR_PREVIEW_MARKER, BOT_FOOTER } from '../shared/constants.js';
import { handlePrPreviewJob } from '../zai-heavy-worker/src/handlers/pr-preview.js';
import { getRepositoryConfig } from '../shared/storage/config.js';
import { writeArtifact } from '../shared/storage/artifacts.js';
import { upsertComment } from '../shared/comments.js';

/** Canonical job record as produced by deliveries.JOB_SELECT. */
function baseJob(overrides = {}) {
  return {
    job_id: 'job-opened',
    repository_id: 10,
    repository_owner: 'owner',
    repository_name: 'repo',
    repository_full_name: 'owner/repo',
    pr_number: 7,
    head_sha: 'sha-1',
    title: 'Title',
    author_login: 'author',
    ...overrides,
  };
}

function makeGithub(headSha) {
  return {
    getPullRequest: vi.fn().mockResolvedValue({ head: { sha: headSha } }),
  };
}

const env = {
  BOT_DB: {},
  BOT_CACHE: { put: vi.fn() },
  BOT_ARTIFACTS: {},
  R2_RETENTION_DAYS: '30',
  GITHUB_BOT_LOGIN: 'zai[bot]',
};

describe('handlePrPreviewJob — generate once, update on synchronize', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getRepositoryConfig.mockResolvedValue({ enabled: true, autoPreview: true, maxFiles: 100 });
    writeArtifact.mockResolvedValue({ artifactId: 'art-1' });
  });

  it('creates the preview comment exactly once for the opened event', async () => {
    upsertComment.mockResolvedValue({ id: 100, created: true });
    const github = makeGithub('sha-1');

    const result = await handlePrPreviewJob({
      github,
      env,
      db: env.BOT_DB,
      job: baseJob({ job_id: 'job-opened', head_sha: 'sha-1' }),
      runId: 'run-1',
    });

    expect(result).toMatchObject({ status: 'success' });
    expect(upsertComment).toHaveBeenCalledOnce();
    expect(upsertComment).toHaveBeenCalledWith(
      expect.objectContaining({
        commentKind: 'pr_preview',
        marker: PR_PREVIEW_MARKER,
        issueNumber: 7,
        repositoryId: 10,
      }),
    );
    expect(github.getPullRequest).toHaveBeenCalledWith('owner', 'repo', 7);
  });

  it('UPDATES the existing comment on synchronize (new commits) instead of creating a new one', async () => {
    // First publication already exists from the opened event (created:true).
    // The synchronize job re-enters upsertComment; the publications table +
    // marker lookup resolve to an UPDATE (created:false).
    upsertComment
      .mockResolvedValueOnce({ id: 100, created: true })
      .mockResolvedValueOnce({ id: 100, created: false });

    const github = {
      getPullRequest: vi
        .fn()
        .mockResolvedValueOnce({ head: { sha: 'sha-1' } })
        .mockResolvedValueOnce({ head: { sha: 'sha-2' } }),
    };

    // 1) opened
    await handlePrPreviewJob({
      github,
      env,
      db: env.BOT_DB,
      job: baseJob({ job_id: 'job-opened', head_sha: 'sha-1' }),
      runId: 'run-1',
    });
    // 2) synchronize — same PR, new head
    await handlePrPreviewJob({
      github,
      env,
      db: env.BOT_DB,
      job: baseJob({ job_id: 'job-sync', head_sha: 'sha-2' }),
      runId: 'run-2',
    });

    expect(upsertComment).toHaveBeenCalledTimes(2);
    // Both publications target the SAME per-PR comment slot, so the second
    // call must reuse comment_kind + marker (the upsertComment contract then
    // updates the single comment_publications row rather than inserting).
    const calls = upsertComment.mock.calls.map((args) => args[0]);
    expect(calls[0].commentKind).toBe('pr_preview');
    expect(calls[1].commentKind).toBe('pr_preview');
    expect(calls[1].marker).toBe(PR_PREVIEW_MARKER);
    // The re-rendered body reflects the new head SHA (metadata-only, no per-file stats).
    expect(calls[1].body).toContain('sha-2');
    expect(calls[1].body).toContain('| **Head** | `sha-2` |');
    // The footer is present on the updated body too.
    expect(calls[1].body).toContain(BOT_FOOTER);
  });

  it('skips a stale job whose head_sha no longer matches the PR (renders only the newest once)', async () => {
    // The PR head has already advanced past the job's recorded SHA — this is
    // the "1 time" guard: only the job carrying the current head renders.
    const github = makeGithub('sha-2');

    const result = await handlePrPreviewJob({
      github,
      env,
      db: env.BOT_DB,
      job: baseJob({ job_id: 'job-stale', head_sha: 'sha-1' }),
      runId: 'run-1',
    });

    expect(result).toMatchObject({ status: 'superseded', headSha: 'sha-2' });
    // The supersede guard short-circuits before any rendering/persistence.
    expect(upsertComment).not.toHaveBeenCalled();
  });

  it('renders the shared footer on every published preview body', async () => {
    upsertComment.mockResolvedValue({ id: 100, created: true });
    await handlePrPreviewJob({
      github: makeGithub('sha-1'),
      env,
      db: env.BOT_DB,
      job: baseJob({ job_id: 'job-opened', head_sha: 'sha-1' }),
      runId: 'run-1',
    });
    const body = upsertComment.mock.calls[0][0].body;
    expect(body).toContain(BOT_FOOTER);
    expect(body).not.toContain('Powered by Z.ai*');
  });
});
