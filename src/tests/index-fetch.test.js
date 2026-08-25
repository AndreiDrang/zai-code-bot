import { beforeEach, describe, expect, it, vi } from 'vitest';

// Integration tests for the zai-main-worker entrypoint (fetch + scheduled).
//
// What is REAL here: the fetch handler itself, webhook signature verification
// (shared/crypto.js — requests are signed with the real HMAC), command parsing
// (shared/commands.js), secret resolution (shared/secrets.js), and the pure
// event predicates (pr-events.js / comment-events.js).
//
// What is MOCKED: GitHubClient, authorizeCommenter, the App token provider
// (github-app-auth.js — provider + token mint), D1 storage (deliveries),
// the queue producer (job-enqueuer), and the R2 slice refreshers — so these
// tests pin the routing/gating contract of index.js without network or
// bindings.

vi.mock('../shared/github.js', () => ({ GitHubClient: vi.fn() }));
vi.mock('../shared/auth.js', () => ({ authorizeCommenter: vi.fn() }));
vi.mock('../shared/github-app-auth.js', () => ({ createTokenProvider: vi.fn() }));
vi.mock('../shared/storage/deliveries.js', () => ({
  createPrContextJob: vi.fn(),
  createCommandJob: vi.fn(),
}));
vi.mock('../zai-main-worker/src/job-enqueuer.js', () => ({
  enqueueJob: vi.fn(),
  recoverExpiredJobs: vi.fn(),
  replayDueOutbox: vi.fn(),
  requeueStrandedJobs: vi.fn(),
  sweepExpiredStorage: vi.fn(),
}));
vi.mock('../shared/pr-comments.js', () => ({ refreshCommentsSlice: vi.fn() }));
vi.mock('../shared/pr-description.js', () => ({ refreshDescriptionSlice: vi.fn() }));

import { GitHubClient } from '../shared/github.js';
import { createTokenProvider } from '../shared/github-app-auth.js';
import { authorizeCommenter } from '../shared/auth.js';
import { createPrContextJob, createCommandJob } from '../shared/storage/deliveries.js';
import {
  enqueueJob,
  recoverExpiredJobs,
  replayDueOutbox,
  requeueStrandedJobs,
  sweepExpiredStorage,
} from '../zai-main-worker/src/job-enqueuer.js';
import { refreshCommentsSlice } from '../shared/pr-comments.js';
import { refreshDescriptionSlice } from '../shared/pr-description.js';
import { hmacSha256Hex } from '../shared/crypto.js';
import { formatHelp, formatCommandNotAvailable } from '../shared/commands.js';
import { COMMENT_MARKER, BOT_FOOTER, HELP_MARKER } from '../shared/constants.js';
import worker from '../zai-main-worker/src/index.js';

const SECRET = 'whsec-test';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeEnv(overrides = {}) {
  return {
    GITHUB_WEBHOOK_SECRET: SECRET,
    GITHUB_APP_ID: '123456',
    GITHUB_APP_PRIVATE_KEY: 'test-app-key',
    BOT_DB: { __db: true },
    BOT_JOBS: { send: vi.fn() },
    BOT_ARTIFACTS: { delete: vi.fn(), put: vi.fn(), get: vi.fn() },
    ...overrides,
  };
}

/** POSTs `body` as a correctly signed GitHub webhook. */
async function signedRequest(
  {
    body,
    event = 'issue_comment',
    delivery = 'd-1',
    secret = SECRET,
    headers = {},
    url = 'https://worker.example/github/webhook',
  } = {},
  env = makeEnv(),
) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const signature = `sha256=${await hmacSha256Hex(secret, raw)}`;
  return worker.fetch(
    new Request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': event,
        'x-github-delivery': delivery,
        'x-hub-signature-256': signature,
        ...headers,
      },
      body: raw,
    }),
    env,
    ctx,
  );
}

/** issue_comment on a PR conversation (parametrized by comment body / action). */
function prCommentPayload({ body = '/zai review', action = 'created', onPr = true } = {}) {
  return {
    action,
    installation: { id: 456 },
    repository: { id: 10, name: 'repo', full_name: 'owner/repo', owner: { login: 'owner' } },
    issue: {
      number: 7,
      ...(onPr ? { pull_request: { url: 'https://api.github.com/repos/owner/repo/pulls/7' } } : {}),
    },
    comment: { body, user: { login: 'alice' } },
    sender: { login: 'alice' },
  };
}

/** pull_request webhook (parametrized by action). */
function prEventPayload(action) {
  return {
    action,
    installation: { id: 456 },
    repository: {
      id: 10,
      name: 'repo',
      full_name: 'owner/repo',
      default_branch: 'main',
      owner: { login: 'owner' },
    },
    pull_request: {
      number: 43,
      title: 'Cloudflare migration',
      state: 'open',
      head: { sha: 'headsha' },
      base: { sha: 'basesha' },
      user: { login: 'pr-author' },
    },
  };
}

/** The PR shape createCommandDurableJob resolves via getPullRequest. */
function prFromApi(overrides = {}) {
  return {
    title: 'Cloudflare migration',
    state: 'open',
    head: { sha: 'headsha' },
    base: { sha: 'basesha' },
    user: { login: 'pr-author' },
    ...overrides,
  };
}

/** Resolves every promise handed to ctx.waitUntil (flushes mirror refreshes). */
function flushWaitUntil(ctx) {
  return Promise.all(ctx.waitUntil.mock.calls.map((call) => call[0]));
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

let github;
let ctx;
let mintToken;

beforeEach(() => {
  vi.clearAllMocks();
  github = {
    getPullRequest: vi.fn().mockResolvedValue(prFromApi()),
    postComment: vi.fn().mockResolvedValue({}),
    updateComment: vi.fn().mockResolvedValue({}),
    getIssueComments: vi.fn().mockResolvedValue([]),
    getAuthenticatedUser: vi.fn().mockResolvedValue({ login: 'zai-pat-bot' }),
  };
  // vitest 4 can only construct callable mocks; arrow-function
  // implementations are rejected by `new`. Keep a constructable class
  // here — lint autofixes must not rewrite this to an arrow function.
  GitHubClient.mockImplementation(
    class {
      constructor() {
        return github;
      }
    },
  );
  // App token provider: available by default, minting a fixed token.
  mintToken = vi.fn().mockResolvedValue('ghs_test');
  createTokenProvider.mockResolvedValue({ available: true, getInstallationToken: mintToken });
  authorizeCommenter.mockResolvedValue(true);
  enqueueJob.mockResolvedValue(true);
  createCommandJob.mockResolvedValue({ job: { job_id: 'cmd-1' }, created: true });
  createPrContextJob.mockResolvedValue({ job: { job_id: 'ctx-1' }, created: true });
  refreshCommentsSlice.mockResolvedValue(undefined);
  refreshDescriptionSlice.mockResolvedValue(undefined);
  ctx = { waitUntil: vi.fn() };
});

// ---------------------------------------------------------------------------
// Gate 0: dedicated webhook path
// ---------------------------------------------------------------------------

describe('webhook path gate', () => {
  it('rejects a non-webhook path with 404 before signature checks', async () => {
    const res = await worker.fetch(
      new Request('https://worker.example/', { method: 'POST', body: '{}' }),
      makeEnv(),
      ctx,
    );
    expect(res.status).toBe(404);
  });

  it('rejects a near-miss path with 404 even when correctly signed', async () => {
    const res = await signedRequest(
      { body: prCommentPayload(), url: 'https://worker.example/webhook' },
      makeEnv(),
    );
    expect(res.status).toBe(404);
    expect(authorizeCommenter).not.toHaveBeenCalled();
  });

  it('tolerates a trailing slash and ignores the query string', async () => {
    for (const url of [
      'https://worker.example/github/webhook/',
      'https://worker.example/github/webhook?probe=1',
    ]) {
      const res = await signedRequest(
        { body: prCommentPayload({ body: 'not a command' }), url },
        makeEnv(),
      );
      expect(res.status).toBe(200);
    }
  });
});

// ---------------------------------------------------------------------------
// Gate 1–3: method, content-type, signature
// ---------------------------------------------------------------------------

describe('request gates', () => {
  it('rejects non-POST methods with 405', async () => {
    const res = await worker.fetch(
      new Request('https://worker.example/github/webhook', { method: 'GET' }),
      makeEnv(),
      ctx,
    );
    expect(res.status).toBe(405);
  });

  it('rejects a non-JSON content type with 415', async () => {
    const res = await worker.fetch(
      new Request('https://worker.example/github/webhook', {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: 'x',
      }),
      makeEnv(),
      ctx,
    );
    expect(res.status).toBe(415);
  });

  it('rejects a bad signature with 401 before touching the payload', async () => {
    const res = await worker.fetch(
      new Request('https://worker.example/github/webhook', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'issue_comment',
          'x-hub-signature-256': 'sha256=deadbeef',
        },
        body: JSON.stringify(prCommentPayload()),
      }),
      makeEnv(),
      ctx,
    );
    expect(res.status).toBe(401);
    expect(authorizeCommenter).not.toHaveBeenCalled();
  });

  it('rejects a missing signature header with 401', async () => {
    const res = await signedRequest(
      { body: prCommentPayload(), headers: { 'x-hub-signature-256': '' } },
      makeEnv(),
    );
    expect(res.status).toBe(401);
  });

  it('answers 500 for a validly signed but unparseable body', async () => {
    const res = await signedRequest({ body: '<<<not-json', event: 'push' });
    expect(res.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// Secret resolution shapes (Secrets Store bindings)
// ---------------------------------------------------------------------------

describe('secret binding shapes', () => {
  it.each([
    ['a string', (s) => s],
    ['a {get()} binding', (s) => ({ get: async () => s })],
    ['a Promise binding', (s) => Promise.resolve(s)],
  ])('accepts GITHUB_WEBHOOK_SECRET surfaced as %s', async (_label, wrap) => {
    const res = await signedRequest(
      { body: prCommentPayload({ body: '/zai help' }) },
      makeEnv({ GITHUB_WEBHOOK_SECRET: wrap(SECRET) }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'help' });
  });
});

// ---------------------------------------------------------------------------
// Command path
// ---------------------------------------------------------------------------

describe('command comments', () => {
  it('ignores a non-command comment (no auth, no storage)', async () => {
    const res = await signedRequest({ body: prCommentPayload({ body: 'nice work' }) });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('OK');
    expect(authorizeCommenter).not.toHaveBeenCalled();
    expect(createCommandJob).not.toHaveBeenCalled();
  });

  it('ignores events without a comment surface (e.g. push)', async () => {
    const res = await signedRequest({
      body: { repository: prEventPayload('opened').repository, sender: { login: 'x' } },
      event: 'push',
    });
    expect(res.status).toBe(200);
    expect(authorizeCommenter).not.toHaveBeenCalled();
  });

  it.each(['edited', 'deleted'])(
    'ignores a /zai command on an %s comment (no re-execution)',
    async (action) => {
      const res = await signedRequest({ body: prCommentPayload({ body: '/zai review', action }) });

      expect(res.status).toBe(200);
      expect(await res.text()).toBe('OK');
      expect(authorizeCommenter).not.toHaveBeenCalled();
      expect(createCommandJob).not.toHaveBeenCalled();
      expect(enqueueJob).not.toHaveBeenCalled();
    },
  );

  it('ignores an edited inline review comment carrying a command (same gate)', async () => {
    const res = await signedRequest({
      body: prCommentPayload({ body: '/zai help', action: 'edited' }),
      event: 'pull_request_review_comment',
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('OK');
    expect(authorizeCommenter).not.toHaveBeenCalled();
    expect(github.postComment).not.toHaveBeenCalled(); // not even inline help runs
    expect(createCommandJob).not.toHaveBeenCalled();
  });

  it('accepts a signed /zai review and enqueues a durable job', async () => {
    const env = makeEnv();
    const res = await signedRequest({ body: prCommentPayload({ body: '/zai review' }) }, env);

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({
      status: 'accepted',
      command: 'review',
      jobId: 'cmd-1',
      durable: true,
    });

    // Auth gate ran with an App-authenticated client for the right user/repo.
    expect(GitHubClient).toHaveBeenCalledWith('ghs_test');
    expect(mintToken).toHaveBeenCalledWith(456);
    expect(authorizeCommenter).toHaveBeenCalledWith(github, 'owner', 'repo', 'alice');

    // The durable event matches the PR-event job shape.
    expect(github.getPullRequest).toHaveBeenCalledWith('owner', 'repo', 7);
    expect(createCommandJob).toHaveBeenCalledWith(
      env.BOT_DB,
      expect.objectContaining({
        eventName: 'issue_comment',
        action: 'created',
        repositoryId: 10,
        repository: { owner: 'owner', name: 'repo', fullName: 'owner/repo', defaultBranch: null },
        prNumber: 7,
        headSha: 'headsha',
        baseSha: 'basesha',
        title: 'Cloudflare migration',
        authorLogin: 'pr-author',
        state: 'open',
        installationId: 456,
      }),
      'review',
    );
    expect(enqueueJob).toHaveBeenCalledWith(env, 'cmd-1');
  });

  it('accepts /zai describe the same way', async () => {
    const res = await signedRequest({ body: prCommentPayload({ body: '/zai describe' }) });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ status: 'accepted', command: 'describe' });
    expect(createCommandJob).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'describe');
  });

  it('falls back to action "created" and null baseSha when the API omits them', async () => {
    github.getPullRequest.mockResolvedValue(prFromApi({ base: undefined }));
    const payload = prCommentPayload({ body: '/zai review' });
    delete payload.action;

    const res = await signedRequest({ body: payload });

    expect(res.status).toBe(202);
    expect(createCommandJob).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'created', baseSha: null }),
      'review',
    );
  });

  it('returns 503 when the PR head cannot be resolved', async () => {
    github.getPullRequest.mockResolvedValue({ head: {} });
    const res = await signedRequest({ body: prCommentPayload({ body: '/zai review' }) });

    expect(res.status).toBe(503);
    expect(createCommandJob).not.toHaveBeenCalled();
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it('returns 503 when enqueueing the durable job fails', async () => {
    enqueueJob.mockRejectedValue(new Error('queue down'));
    const res = await signedRequest({ body: prCommentPayload({ body: '/zai review' }) });

    expect(res.status).toBe(503);
  });

  it('returns 503 when a heavy command arrives on a non-PR issue', async () => {
    const res = await signedRequest({
      body: prCommentPayload({ body: '/zai review', onPr: false }),
    });

    expect(res.status).toBe(503);
    expect(createCommandJob).not.toHaveBeenCalled();
  });

  it('rejects an unauthorized commenter with 403 and posts a marker notice', async () => {
    authorizeCommenter.mockResolvedValue(false);
    github.postComment.mockResolvedValue({});
    const res = await signedRequest({
      body: {
        ...prCommentPayload({ body: '/zai review' }),
        comment: { body: '/zai review', user: { login: 'bob' } },
      },
    });

    expect(res.status).toBe(403);
    expect(github.postComment).toHaveBeenCalledTimes(1);
    const postedBody = github.postComment.mock.calls[0][3];
    expect(postedBody).toContain('@bob');
    expect(postedBody).toContain(COMMENT_MARKER);
    expect(postedBody).toContain(BOT_FOOTER);
    expect(createCommandJob).not.toHaveBeenCalled();
  });

  it('still answers 403 when the unauthorized notice fails to post', async () => {
    authorizeCommenter.mockResolvedValue(false);
    github.postComment.mockRejectedValue(new Error('github down'));
    const res = await signedRequest({ body: prCommentPayload({ body: '/zai review' }) });

    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Help & unsupported commands (inline responses)
// ---------------------------------------------------------------------------

describe('inline commands', () => {
  it('posts the help comment when none exists yet', async () => {
    const res = await signedRequest({ body: prCommentPayload({ body: '/zai help' }) });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'help', command: 'help' });
    expect(github.postComment).toHaveBeenCalledWith('owner', 'repo', 7, formatHelp());
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it('updates the existing help comment instead of posting a new one', async () => {
    github.getIssueComments.mockResolvedValue([
      { id: 55, body: `old help ${HELP_MARKER} old`, user: { login: 'zai-bot', type: 'Bot' } },
    ]);

    const res = await signedRequest({ body: prCommentPayload({ body: '/zai help' }) });

    expect(res.status).toBe(200);
    expect(github.updateComment).toHaveBeenCalledWith('owner', 'repo', 55, formatHelp());
    expect(github.postComment).not.toHaveBeenCalled();
  });

  it('does not rewrite a user comment embedding the help marker', async () => {
    github.getIssueComments.mockResolvedValue([
      { id: 77, body: `nice try ${HELP_MARKER}`, user: { login: 'mallory', type: 'User' } },
    ]);

    const res = await signedRequest({ body: prCommentPayload({ body: '/zai help' }) });

    expect(res.status).toBe(200);
    expect(github.updateComment).not.toHaveBeenCalled();
    expect(github.postComment).toHaveBeenCalledWith('owner', 'repo', 7, formatHelp());
  });

  it('updates a PAT-era help comment only via the configured GITHUB_BOT_LOGIN var', async () => {
    github.getIssueComments.mockResolvedValue([
      { id: 88, body: `help ${HELP_MARKER}`, user: { login: 'pat-bot', type: 'User' } },
    ]);

    const res = await signedRequest(
      { body: prCommentPayload({ body: '/zai help' }) },
      makeEnv({ GITHUB_BOT_LOGIN: 'pat-bot' }),
    );

    expect(res.status).toBe(200);
    expect(github.updateComment).toHaveBeenCalledWith('owner', 'repo', 88, formatHelp());
    expect(github.postComment).not.toHaveBeenCalled();
    // App-only auth: the worker never probes GET /user (installation tokens
    // cannot call it); the login comes exclusively from the env var.
    expect(github.getAuthenticatedUser).not.toHaveBeenCalled();
  });

  it('posts a fresh help comment when a PAT-era help comment exists but GITHUB_BOT_LOGIN is unset', async () => {
    github.getIssueComments.mockResolvedValue([
      { id: 88, body: `help ${HELP_MARKER}`, user: { login: 'pat-bot', type: 'User' } },
    ]);

    const res = await signedRequest({ body: prCommentPayload({ body: '/zai help' }) });

    expect(res.status).toBe(200);
    // Without the var, a type 'User' comment is not recognized as bot-owned;
    // a new help comment is posted once instead of rewriting it.
    expect(github.updateComment).not.toHaveBeenCalled();
    expect(github.postComment).toHaveBeenCalledWith('owner', 'repo', 7, formatHelp());
  });

  it('prefers GITHUB_BOT_LOGIN over the API lookup', async () => {
    github.getIssueComments.mockResolvedValue([
      { id: 99, body: `help ${HELP_MARKER}`, user: { login: 'configured-bot', type: 'User' } },
    ]);

    const res = await signedRequest(
      { body: prCommentPayload({ body: '/zai help' }) },
      makeEnv({ GITHUB_BOT_LOGIN: 'configured-bot' }),
    );

    expect(res.status).toBe(200);
    expect(github.updateComment).toHaveBeenCalledWith('owner', 'repo', 99, formatHelp());
    expect(github.getAuthenticatedUser).not.toHaveBeenCalled();
  });

  it('answers 200 even when the help lookup fails (best-effort)', async () => {
    github.getIssueComments.mockRejectedValue(new Error('github down'));

    const res = await signedRequest({ body: prCommentPayload({ body: '/zai help' }) });

    expect(res.status).toBe(200);
    expect(github.postComment).not.toHaveBeenCalled();
  });

  it('answers an unknown /zai command with the not-available comment', async () => {
    const res = await signedRequest({ body: prCommentPayload({ body: '/zai bogus' }) });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'unsupported', command: 'bogus' });
    expect(github.postComment).toHaveBeenCalledWith(
      'owner',
      'repo',
      7,
      formatCommandNotAvailable('bogus'),
    );
    expect(createCommandJob).not.toHaveBeenCalled();
  });

  it('still answers 200 for an unknown command when posting fails (best-effort)', async () => {
    github.postComment.mockRejectedValue(new Error('github down'));

    const res = await signedRequest({ body: prCommentPayload({ body: '/zai bogus' }) });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'unsupported' });
  });
});

// ---------------------------------------------------------------------------
// PR-context path (pull_request → pr_context job)
// ---------------------------------------------------------------------------

describe('pull_request events', () => {
  it('accepts a synchronize event as a durable pr_context job', async () => {
    const env = makeEnv();
    const res = await signedRequest(
      { body: prEventPayload('synchronize'), event: 'pull_request' },
      env,
    );

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({
      status: 'accepted',
      kind: 'pr_context',
      jobId: 'ctx-1',
      duplicate: false,
    });

    expect(createPrContextJob).toHaveBeenCalledWith(
      env.BOT_DB,
      {
        deliveryId: 'd-1',
        action: 'synchronize',
        repositoryId: 10,
        repository: {
          owner: 'owner',
          name: 'repo',
          fullName: 'owner/repo',
          defaultBranch: 'main',
        },
        prNumber: 43,
        headSha: 'headsha',
        baseSha: 'basesha',
        title: 'Cloudflare migration',
        authorLogin: 'pr-author',
        state: 'open',
      },
      456,
    );
    expect(enqueueJob).toHaveBeenCalledWith(env, 'ctx-1');
    expect(authorizeCommenter).not.toHaveBeenCalled(); // PR events bypass the command path
  });

  it('reports a duplicate when the context job already exists', async () => {
    createPrContextJob.mockResolvedValue({ job: { job_id: 'ctx-1' }, created: false });

    const res = await signedRequest({ body: prEventPayload('opened'), event: 'pull_request' });

    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ duplicate: true });
    expect(enqueueJob).toHaveBeenCalledWith(expect.anything(), 'ctx-1');
  });

  it('returns 503 when storage bindings are missing', async () => {
    const res = await signedRequest(
      { body: prEventPayload('synchronize'), event: 'pull_request' },
      makeEnv({ BOT_DB: undefined, BOT_JOBS: undefined }),
    );

    expect(res.status).toBe(503);
    expect(createPrContextJob).not.toHaveBeenCalled();
  });

  it('returns 503 when the delivery header is missing (payload not extractable)', async () => {
    const res = await signedRequest({
      body: prEventPayload('synchronize'),
      event: 'pull_request',
      delivery: '',
    });

    expect(res.status).toBe(503);
  });

  it('returns 503 when enqueueing the context job fails', async () => {
    enqueueJob.mockRejectedValue(new Error('queue down'));

    const res = await signedRequest({ body: prEventPayload('synchronize'), event: 'pull_request' });

    expect(res.status).toBe(503);
  });

  it('lets non-trigger actions fall through as ignored', async () => {
    for (const action of ['closed', 'labeled']) {
      const res = await signedRequest({ body: prEventPayload(action), event: 'pull_request' });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('OK');
    }
    expect(createPrContextJob).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// GitHub App authentication (Gate 4.5 — App-only, no PAT fallback)
// ---------------------------------------------------------------------------

describe('GitHub App authentication', () => {
  it('never mints a token for a pull_request synchronize event', async () => {
    // Fix for the eager-mint regression: PR-context events only write D1 and
    // enqueue; they must not pay a JWT + token-endpoint round trip.
    const res = await signedRequest(
      { body: prEventPayload('synchronize'), event: 'pull_request' },
      makeEnv(),
    );

    expect(res.status).toBe(202);
    expect(createTokenProvider).not.toHaveBeenCalled();
    expect(mintToken).not.toHaveBeenCalled();
  });

  it('never mints a token for a plain issue comment (no mirror, no command)', async () => {
    const res = await signedRequest({ body: prCommentPayload({ body: 'hello', onPr: false }) });

    expect(res.status).toBe(200);
    expect(createTokenProvider).not.toHaveBeenCalled();
  });

  it('never mints a token for an ignored pull_request action', async () => {
    const res = await signedRequest(
      { body: prEventPayload('closed'), event: 'pull_request' },
      makeEnv(),
    );

    expect(res.status).toBe(200);
    expect(createTokenProvider).not.toHaveBeenCalled();
  });

  it('returns 503 and creates no job when the payload carries no installation id', async () => {
    const payload = prCommentPayload({ body: '/zai review' });
    delete payload.installation;

    const res = await signedRequest({ body: payload });

    expect(res.status).toBe(503);
    expect(authorizeCommenter).not.toHaveBeenCalled();
    expect(createCommandJob).not.toHaveBeenCalled();
  });

  it('returns 503 when the App credentials are not configured', async () => {
    createTokenProvider.mockResolvedValue({ available: false, getInstallationToken: vi.fn() });

    const res = await signedRequest({ body: prCommentPayload({ body: '/zai review' }) });

    expect(res.status).toBe(503);
    expect(mintToken).not.toHaveBeenCalled();
    expect(createCommandJob).not.toHaveBeenCalled();
  });

  it('returns 503 (not 500) when the token mint fails', async () => {
    // Persistent rejection: a PR comment also feeds the mirror path, which
    // consumes (and swallows) the first mint attempt before Gate 4.5 runs.
    mintToken.mockRejectedValue(
      Object.assign(new Error('GitHub API error: 500'), {
        code: 'app_token_fetch_failed',
        retryable: true,
      }),
    );

    const res = await signedRequest({ body: prCommentPayload({ body: '/zai review' }) });
    await flushWaitUntil(ctx);

    expect(res.status).toBe(503);
    expect(authorizeCommenter).not.toHaveBeenCalled();
    expect(createCommandJob).not.toHaveBeenCalled();
  });

  it('skips the comment mirror when App auth fails but still acks 200', async () => {
    mintToken.mockRejectedValueOnce(
      Object.assign(new Error('GitHub API error: 500'), { code: 'app_token_fetch_failed' }),
    );

    const res = await signedRequest({ body: prCommentPayload({ body: 'hello' }) });
    await flushWaitUntil(ctx);

    expect(res.status).toBe(200);
    expect(refreshCommentsSlice).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Mirror paths: comments slice + description slice refreshes (ctx.waitUntil)
// ---------------------------------------------------------------------------

describe('comments slice mirror', () => {
  it('refreshes the comments slice for a PR conversation comment', async () => {
    const env = makeEnv();
    const res = await signedRequest({ body: prCommentPayload({ body: 'hello' }) }, env);
    await flushWaitUntil(ctx);

    expect(res.status).toBe(200);
    expect(refreshCommentsSlice).toHaveBeenCalledWith({
      github: expect.anything(),
      bucket: env.BOT_ARTIFACTS,
      owner: 'owner',
      name: 'repo',
      prNumber: 7,
      repoId: 10,
    });
    expect(authorizeCommenter).not.toHaveBeenCalled();
  });

  it('keeps the ack when the comments refresh fails (best-effort)', async () => {
    refreshCommentsSlice.mockRejectedValue(new Error('r2 down'));

    const res = await signedRequest({ body: prCommentPayload({ body: 'hello' }) });
    await flushWaitUntil(ctx);

    expect(res.status).toBe(200);
  });

  it('still refreshes the slice for a deleted command comment while NOT executing it', async () => {
    const env = makeEnv();
    const res = await signedRequest(
      { body: prCommentPayload({ body: '/zai review', action: 'deleted' }) },
      env,
    );
    await flushWaitUntil(ctx);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('OK');
    expect(refreshCommentsSlice).toHaveBeenCalledWith(
      expect.objectContaining({ prNumber: 7, repoId: 10 }),
    );
    expect(authorizeCommenter).not.toHaveBeenCalled();
    expect(createCommandJob).not.toHaveBeenCalled();
  });

  it('skips the refresh for comments on plain issues', async () => {
    const res = await signedRequest({ body: prCommentPayload({ body: 'hello', onPr: false }) });

    expect(res.status).toBe(200);
    expect(ctx.waitUntil).not.toHaveBeenCalled();
    expect(refreshCommentsSlice).not.toHaveBeenCalled();
  });

  it('skips the refresh when R2 is not bound', async () => {
    const res = await signedRequest(
      { body: prCommentPayload({ body: 'hello' }) },
      makeEnv({ BOT_ARTIFACTS: undefined }),
    );

    expect(res.status).toBe(200);
    expect(refreshCommentsSlice).not.toHaveBeenCalled();
  });

  it('skips the refresh when the plan cannot be resolved (broken repository)', async () => {
    const payload = prCommentPayload({ body: 'hello' });
    payload.repository = { id: 10 }; // no owner/name → plan is null

    const res = await signedRequest({ body: payload });

    expect(res.status).toBe(200);
    expect(refreshCommentsSlice).not.toHaveBeenCalled();
  });
});

describe('description slice mirror', () => {
  function descriptionEditPayload(changes) {
    return {
      ...prEventPayload('edited'),
      changes,
      pull_request: { ...prEventPayload('edited').pull_request, body: 'new body' },
    };
  }

  it('writes the payload body straight to the description slice (no API call)', async () => {
    const env = makeEnv();
    const res = await signedRequest(
      { body: descriptionEditPayload({ body: { from: 'old body' } }), event: 'pull_request' },
      env,
    );
    await flushWaitUntil(ctx);

    expect(res.status).toBe(200);
    expect(refreshDescriptionSlice).toHaveBeenCalledWith({
      bucket: env.BOT_ARTIFACTS,
      repoId: 10,
      prNumber: 43,
      body: 'new body',
    });
    expect(github.getIssueComments).not.toHaveBeenCalled();
  });

  it('keeps the ack when the description write fails (best-effort)', async () => {
    refreshDescriptionSlice.mockRejectedValue(new Error('r2 down'));

    const res = await signedRequest({
      body: descriptionEditPayload({ body: { from: 'old' } }),
      event: 'pull_request',
    });
    await flushWaitUntil(ctx);

    expect(res.status).toBe(200);
  });

  it('skips title-only edits', async () => {
    const res = await signedRequest({
      body: descriptionEditPayload({ title: { from: 'old title' } }),
      event: 'pull_request',
    });

    expect(res.status).toBe(200);
    expect(refreshDescriptionSlice).not.toHaveBeenCalled();
  });

  it('skips when the plan cannot be resolved (missing repository id)', async () => {
    const payload = descriptionEditPayload({ body: { from: 'old' } });
    payload.repository = { name: 'repo', owner: { login: 'owner' } }; // no id → plan null

    const res = await signedRequest({ body: payload, event: 'pull_request' });

    expect(res.status).toBe(200);
    expect(refreshDescriptionSlice).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// scheduled (recovery cron)
// ---------------------------------------------------------------------------

describe('scheduled handler', () => {
  it('runs lease recovery, outbox replay, stranded sweep, and the storage sweep with bounded limits', async () => {
    const leases = { found: 1, requeued: 1, failed: 0 };
    const outbox = { found: 2, published: 1 };
    const stranded = { found: 1, requeued: 1 };
    const artifacts = { found: 3, deleted: 2 };
    recoverExpiredJobs.mockResolvedValue(leases);
    replayDueOutbox.mockResolvedValue(outbox);
    requeueStrandedJobs.mockResolvedValue(stranded);
    sweepExpiredStorage.mockResolvedValue(artifacts);

    const env = makeEnv();
    const result = await worker.scheduled({}, env);

    expect(result).toEqual({ leases, outbox, stranded, artifacts });
    expect(recoverExpiredJobs).toHaveBeenCalledWith(env, 100);
    expect(replayDueOutbox).toHaveBeenCalledWith(env, 25);
    expect(requeueStrandedJobs).toHaveBeenCalledWith(env, 25);
    expect(sweepExpiredStorage).toHaveBeenCalledWith(env, 100);
  });
});
