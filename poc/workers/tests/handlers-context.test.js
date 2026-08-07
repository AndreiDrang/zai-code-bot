import { describe, expect, it, vi } from 'vitest';

// Keep the handlers' logger dependency a no-op so tests focus on the read flow.
vi.mock('../shared/logging.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { handleImpactCommand } from '../zai-heavy-worker/src/handlers/impact.js';
import { handleAskCommand } from '../zai-heavy-worker/src/handlers/ask.js';
import { handleExplainCommand } from '../zai-heavy-worker/src/handlers/explain.js';
import { prCardKey, prContextKey } from '../shared/storage/keys.js';

const REPO_ID = 10;
const PR = 7;
const HEAD = 'abc';
const payload = {
  repository: { id: REPO_ID, owner: 'o', name: 'r', full_name: 'o/r' },
  issue: { number: 7 },
  prNumber: PR,
};

const card = {
  repositoryId: REPO_ID,
  prNumber: PR,
  headSha: HEAD,
  title: 'T',
  authorLogin: 'author',
  state: 'open',
  changedFiles: 3,
  additions: 9,
  deletions: 1,
  contextReady: true,
};
const manifest = {
  repositoryId: REPO_ID,
  prNumber: PR,
  headSha: HEAD,
  counts: { files: 2, commits: 1, issueComments: 1, reviewComments: 0 },
  aggregates: { additions: 10, deletions: 2 },
};

/** Builds env with fake KV (pr-card) + R2 (manifest) bindings. */
function makeEnv({ withCard = false, withManifest = false } = {}) {
  const cache = {
    get: vi.fn(async (key) =>
      key === prCardKey(REPO_ID, PR) && withCard ? structuredClone(card) : null,
    ),
  };
  const bucket = {
    get: vi.fn(async (key) =>
      key === prContextKey(REPO_ID, PR, HEAD, 'manifest') && withManifest
        ? { text: async () => JSON.stringify(manifest) }
        : null,
    ),
  };
  return { env: { BOT_CACHE: cache, BOT_ARTIFACTS: bucket }, cache, bucket };
}

function makeGithub() {
  return { postComment: vi.fn().mockResolvedValue({ id: 1 }) };
}

describe('impact — context-aware reader', () => {
  it('impact surfaces the gathered summary when context is ready', async () => {
    const { env } = makeEnv({ withCard: true, withManifest: true });
    const github = makeGithub();
    const res = await handleImpactCommand({ github, env, payload });
    const body = github.postComment.mock.calls[0][3];
    expect(body).toContain('gathered and ready');
    expect(res.contextReady).toBe(true);
  });
});

describe('ask / explain — pr-card readers', () => {
  it('ask includes the PR shape when a card exists', async () => {
    const { env } = makeEnv({ withCard: true });
    const github = makeGithub();
    const res = await handleAskCommand({ github, env, payload });
    const body = github.postComment.mock.calls[0][3];
    expect(body).toContain('PR context: #7 by @author');
    expect(body).toContain('3 files');
    expect(res.headSha).toBe(HEAD);
  });

  it('ask posts the generic stub when no card exists', async () => {
    const { env } = makeEnv({ withCard: false });
    const github = makeGithub();
    await handleAskCommand({ github, env, payload });
    const body = github.postComment.mock.calls[0][3];
    expect(body).toContain('queued on the heavy worker');
    expect(body).not.toContain('PR context:');
  });

  it('explain includes the PR shape when a card exists', async () => {
    const { env } = makeEnv({ withCard: true });
    const github = makeGithub();
    await handleExplainCommand({ github, env, payload });
    const body = github.postComment.mock.calls[0][3];
    expect(body).toContain('PR context: #7 by @author');
  });
});
