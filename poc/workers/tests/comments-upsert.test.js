import { describe, expect, it, vi } from 'vitest';

// These tests exercise the REAL upsertComment (comments.js is NOT mocked) against
// a tiny in-memory D1 fake and a mocked GitHubClient. The earlier pr-preview-sync
// suite mocked upsertComment wholesale, so it could not catch the
// findMarkerComment author-filter bug that caused a NEW comment on every
// synchronize. This file closes that gap.

import { PR_PREVIEW_MARKER, BOT_FOOTER } from '../shared/constants.js';
import { upsertComment } from '../shared/comments.js';

/**
 * Minimal D1 fake backing only the comment_publications statements used by
 * comments.js (findPublication SELECT, claimPublication INSERT ... ON
 * CONFLICT, finalizePublication UPDATE). Mirrors the real SQL semantics for
 * the columns upsertComment reads (notably: claimPublication PRESERVES
 * github_comment_id across syncs, finalizePublication persists it).
 */
function createFakeDb() {
  const rows = new Map();
  const keyOf = (repoId, pr, kind) => `${repoId}:${pr}:${kind}`;

  return {
    prepare(sql) {
      return {
        bind(...bindings) {
          return {
            async first() {
              if (/^\s*SELECT/i.test(sql)) {
                const [repoId, pr, kind] = bindings;
                const row = rows.get(keyOf(repoId, pr, kind));
                return row ? { ...row } : null;
              }
              return null;
            },
            async run() {
              const meta = (changes) => ({ meta: { changes } });
              if (/^\s*INSERT/i.test(sql)) {
                // claimPublication — bindings:
                // [repoId, pr, kind, marker, jobId, leaseExpiresAt, now, now]
                const [repoId, pr, kind, marker, jobId, leaseExpiresAt, now] = bindings;
                const k = keyOf(repoId, pr, kind);
                const prev = rows.get(k);
                const claimable =
                  !prev ||
                  prev.status !== 'publishing' ||
                  prev.lease_job_id === jobId ||
                  prev.lease_expires_at === null ||
                  prev.lease_expires_at <= now;
                if (!claimable) return meta(0);
                rows.set(k, {
                  repository_id: repoId,
                  pr_number: pr,
                  comment_kind: kind,
                  current_head_sha: prev?.current_head_sha ?? null,
                  github_comment_id: prev?.github_comment_id ?? null, // preserved on conflict
                  marker,
                  status: 'publishing',
                  lease_job_id: jobId,
                  lease_expires_at: leaseExpiresAt,
                  body_artifact_id: prev?.body_artifact_id ?? null,
                  created_at: prev?.created_at ?? now,
                  updated_at: now,
                });
                return meta(1);
              }
              if (/^\s*UPDATE/i.test(sql)) {
                // finalizePublication — bindings:
                // [headSha, githubCommentId, marker, bodyArtifactId, now, repoId, pr, kind, jobId]
                const [
                  headSha,
                  githubCommentId,
                  marker,
                  bodyArtifactId,
                  now,
                  repoId,
                  pr,
                  kind,
                  jobId,
                ] = bindings;
                const k = keyOf(repoId, pr, kind);
                const row = rows.get(k);
                if (!row || row.status !== 'publishing' || row.lease_job_id !== jobId) {
                  return meta(0);
                }
                rows.set(k, {
                  ...row,
                  current_head_sha: headSha,
                  github_comment_id: githubCommentId,
                  marker,
                  status: 'published',
                  lease_job_id: null,
                  lease_expires_at: null,
                  body_artifact_id: bodyArtifactId,
                  updated_at: now,
                });
                return meta(1);
              }
              return meta(0);
            },
          };
        },
      };
    },
    getRow(repoId, pr, kind) {
      const row = rows.get(keyOf(repoId, pr, kind));
      return row ? { ...row } : undefined;
    },
  };
}

function renderBody(headSha) {
  return `## PR Preview\n\nhead: \`${headSha}\`\n\n${BOT_FOOTER} ${PR_PREVIEW_MARKER}`;
}

function comment(id, headSha, author) {
  return {
    id,
    body: renderBody(headSha),
    user: author,
  };
}

function makeGithub({ issueComments = [] } = {}) {
  return {
    getIssueComments: vi.fn().mockResolvedValue(issueComments),
    // updateComment returns the (updated) comment object so upsertComment can
    // read comment.id; postComment returns a brand-new id to make a duplicate
    // observable.
    updateComment: vi.fn().mockResolvedValue({ id: issueComments[0]?.id ?? 100 }),
    postComment: vi.fn().mockResolvedValue({ id: 999 }),
  };
}

const baseArgs = {
  owner: 'owner',
  repo: 'repo',
  issueNumber: 7,
  repositoryId: 10,
  commentKind: 'pr_preview',
  marker: PR_PREVIEW_MARKER,
};

describe('upsertComment — generate once, update on synchronize (real path)', () => {
  it('UPDATES the previous comment on synchronize when it was posted by a PAT-owned bot (type User) and GITHUB_BOT_LOGIN is unset', async () => {
    const db = createFakeDb();
    const prior = comment(100, 'sha-1', { login: 'AndreiDrang', type: 'User' });
    // Fresh PR on opened (no prior comments), then the prior comment is present on sync.
    const github = {
      getIssueComments: vi
        .fn()
        .mockResolvedValueOnce([]) // opened: nothing yet
        .mockResolvedValueOnce([prior]), // sync: our previous comment (type 'User')
      updateComment: vi.fn().mockResolvedValue({ id: 100 }),
      // opened creates comment 100; a later (duplicate) create would surface as 999.
      postComment: vi.fn().mockResolvedValueOnce({ id: 100 }).mockResolvedValue({ id: 999 }),
    };

    // 1) opened — creates the first comment (id 100) and records it in D1
    await upsertComment({
      ...baseArgs,
      github,
      db,
      headSha: 'sha-1',
      body: renderBody('sha-1'),
      jobId: 'job-opened',
      botLogin: null, // GITHUB_BOT_LOGIN unset in production wrangler.toml
    });
    expect(github.postComment).toHaveBeenCalledOnce();
    expect(github.updateComment).not.toHaveBeenCalled();
    expect(db.getRow(10, 7, 'pr_preview').github_comment_id).toBe(100);

    // 2) synchronize — new commits; the previous comment is authored by a
    //    type 'User' PAT and no bot login is configured. Without the fix this
    //    filtered the marker comment out and created a NEW comment (id 999).
    await upsertComment({
      ...baseArgs,
      github,
      db,
      headSha: 'sha-2',
      body: renderBody('sha-2'),
      jobId: 'job-sync',
      botLogin: null,
    });

    expect(github.updateComment).toHaveBeenCalledOnce();
    expect(github.updateComment).toHaveBeenCalledWith(
      'owner',
      'repo',
      100,
      expect.stringContaining('sha-2'),
    );
    // No SECOND comment was created — postComment still called exactly once.
    expect(github.postComment).toHaveBeenCalledOnce();
    // Same comment id, refreshed head.
    const stored = db.getRow(10, 7, 'pr_preview');
    expect(stored.github_comment_id).toBe(100);
    expect(stored.current_head_sha).toBe('sha-2');
    expect(stored.status).toBe('published');
  });

  it('UPDATES the previous comment when it was posted by a GitHub App (type Bot)', async () => {
    const db = createFakeDb();
    const prior = comment(100, 'sha-1', { login: 'zai[bot]', type: 'Bot' });
    const github = {
      getIssueComments: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([prior]),
      updateComment: vi.fn().mockResolvedValue({ id: 100 }),
      postComment: vi.fn().mockResolvedValueOnce({ id: 100 }).mockResolvedValue({ id: 999 }),
    };

    await upsertComment({
      ...baseArgs,
      github,
      db,
      headSha: 'sha-1',
      body: renderBody('sha-1'),
      jobId: 'job-opened',
      botLogin: 'zai[bot]',
    });
    await upsertComment({
      ...baseArgs,
      github,
      db,
      headSha: 'sha-2',
      body: renderBody('sha-2'),
      jobId: 'job-sync',
      botLogin: 'zai[bot]',
    });

    expect(github.updateComment).toHaveBeenCalledOnce();
    expect(github.postComment).toHaveBeenCalledOnce(); // only the opened create
    expect(db.getRow(10, 7, 'pr_preview').github_comment_id).toBe(100);
  });

  it('creates a new comment when no prior marker comment exists (fresh opened event)', async () => {
    const db = createFakeDb();
    const github = makeGithub({ issueComments: [] });

    const result = await upsertComment({
      ...baseArgs,
      github,
      db,
      headSha: 'sha-1',
      body: renderBody('sha-1'),
      jobId: 'job-opened',
      botLogin: null,
    });

    expect(result.created).toBe(true);
    expect(github.postComment).toHaveBeenCalledOnce();
    expect(github.updateComment).not.toHaveBeenCalled();
    expect(db.getRow(10, 7, 'pr_preview').status).toBe('published');
  });

  it('does not adopt a stray type User comment that carries the marker but is not the stored id', async () => {
    // Defense check: with botLogin unset, a foreign type 'User' comment that
    // merely quotes our marker must NOT be adopted on the marker-only path
    // (expectedCommentId is null because we never published it). This keeps the
    // relaxed stored-id acceptance from widening into comment hijacking.
    const db = createFakeDb();
    const stray = comment(555, 'sha-x', { login: 'someone-else', type: 'User' });
    const github = makeGithub({ issueComments: [stray] });

    const result = await upsertComment({
      ...baseArgs,
      github,
      db,
      headSha: 'sha-1',
      body: renderBody('sha-1'),
      jobId: 'job-opened',
      botLogin: null, // no way to identify ourselves -> must create, not adopt
    });

    expect(result.created).toBe(true);
    expect(github.postComment).toHaveBeenCalledWith('owner', 'repo', 7, expect.any(String));
    expect(github.updateComment).not.toHaveBeenCalledWith('owner', 'repo', 555, expect.anything());
  });
});
