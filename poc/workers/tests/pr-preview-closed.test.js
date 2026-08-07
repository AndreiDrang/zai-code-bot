import { describe, expect, it, vi, beforeEach } from 'vitest';

// Exercises the closed-lifecycle branch of handlePrPreviewJob in isolation.
// The storage + comment collaborators are mocked; renderPrClosed is left REAL
// so the rendered "PR closed by @X" body is asserted verbatim. This proves the
// close path posts the pr_closed comment, skips the supersede GET, and leaves
// the preview comment untouched.

vi.mock('../shared/comments.js', () => ({
  upsertComment: vi.fn().mockResolvedValue({ id: 4242, created: true }),
}));
vi.mock('../shared/storage/config.js', () => ({
  getRepositoryConfig: vi.fn().mockResolvedValue({ enabled: true, autoPreview: true }),
}));
vi.mock('../shared/storage/artifacts.js', () => ({
  writeArtifact: vi.fn().mockResolvedValue({ artifactId: 'art-closed-1' }),
  artifactExpiresAt: vi.fn().mockReturnValue('2099-01-01T00:00:00.000Z'),
}));
vi.mock('../shared/storage/jobs.js', () => ({
  linkRunResultArtifact: vi.fn().mockResolvedValue(undefined),
}));

import { handlePrPreviewJob } from '../zai-heavy-worker/src/handlers/pr-preview.js';
import { upsertComment } from '../shared/comments.js';
import { getRepositoryConfig } from '../shared/storage/config.js';
import { writeArtifact } from '../shared/storage/artifacts.js';
import { PR_CLOSED_MARKER } from '../shared/constants.js';

function makeEnv() {
  return {
    BOT_ARTIFACTS: {},
    BOT_CACHE: { put: vi.fn() },
    GITHUB_BOT_LOGIN: null,
    R2_RETENTION_DAYS: 7,
  };
}

function makeGithub() {
  return {
    getPullRequest: vi.fn(),
    getIssueComments: vi.fn(),
    updateComment: vi.fn(),
    postComment: vi.fn(),
  };
}

const closedJob = {
  job_id: 'job-closed',
  repository_id: 10,
  repository_owner: 'o',
  repository_name: 'repo',
  repository_full_name: 'o/repo',
  pr_number: 43,
  head_sha: '7d08f4bd0f174dc95e61355f977a12942c4d4c65',
  state: 'closed',
  closed_by: 'AndreiDrang',
  title: 'To cloudflare migration',
  author_login: 'AndreiDrang',
};

describe('handlePrPreviewJob — closed lifecycle branch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('posts the idempotent "PR closed by @X" comment and skips the supersede guard', async () => {
    getRepositoryConfig.mockResolvedValue({ enabled: true, autoPreview: true });
    const github = makeGithub();

    const result = await handlePrPreviewJob({
      github,
      env: makeEnv(),
      db: {},
      job: closedJob,
      runId: 'run-1',
    });

    expect(result).toMatchObject({ status: 'success', action: 'pr_closed' });
    // No supersede GET on the close path — head SHA is irrelevant for a close.
    expect(github.getPullRequest).not.toHaveBeenCalled();
    expect(writeArtifact).toHaveBeenCalledOnce();

    const body = writeArtifact.mock.calls[0][0].content;
    expect(body).toContain('## 🔒 PR Closed');
    expect(body).toContain('PR closed by @AndreiDrang');
    expect(body).toContain(PR_CLOSED_MARKER);

    expect(upsertComment).toHaveBeenCalledOnce();
    expect(upsertComment).toHaveBeenCalledWith(
      expect.objectContaining({
        commentKind: 'pr_closed',
        marker: PR_CLOSED_MARKER,
        issueNumber: 43,
        repositoryId: 10,
        bodyArtifactId: 'art-closed-1',
      }),
    );
  });

  it('does nothing when auto-preview is disabled', async () => {
    getRepositoryConfig.mockResolvedValue({ enabled: true, autoPreview: false });
    const github = makeGithub();

    const result = await handlePrPreviewJob({
      github,
      env: makeEnv(),
      db: {},
      job: closedJob,
      runId: 'run-1',
    });

    expect(result).toEqual({ status: 'disabled' });
    expect(upsertComment).not.toHaveBeenCalled();
    expect(writeArtifact).not.toHaveBeenCalled();
    expect(github.getPullRequest).not.toHaveBeenCalled();
  });

  it('does not take the closed branch for an open PR (falls through to preview)', async () => {
    getRepositoryConfig.mockResolvedValue({ enabled: true, autoPreview: true });
    const github = makeGithub();
    github.getPullRequest.mockResolvedValue({ head: { sha: closedJob.head_sha } }); // not superseded

    await handlePrPreviewJob({
      github,
      env: makeEnv(),
      db: {},
      job: { ...closedJob, state: 'open' },
      runId: 'run-1',
    });

    // The open path runs the supersede guard and never posts a pr_closed comment.
    expect(github.getPullRequest).toHaveBeenCalledOnce();
    const kinds = upsertComment.mock.calls.map((call) => call[0].commentKind);
    expect(kinds).not.toContain('pr_closed');
    expect(kinds).toContain('pr_preview');
  });
});
