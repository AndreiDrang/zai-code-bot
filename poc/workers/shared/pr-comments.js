import { prContextKey } from './storage/keys.js';

/**
 * Comment-slice helpers shared by the eager gather (heavy worker) and the
 * incremental comment refresh (main worker).
 *
 * The `comments` context slice (`v1/prs/{repo}/{pr}/context/comments.json`) has
 * TWO writers — the gather, which re-captures every slice on each new head, and
 * the comment-refresh, which keeps the slice fresh between pushes when an
 * `issue_comment` event fires. Both writers MUST produce the identical shape, so
 * the projection lives here and is imported by both. Last-writer-wins on the
 * single R2 key is safe precisely because the projection is shared.
 */

/**
 * Projects raw GitHub comment pages (the shape returned by `getPrComments`) into
 * the compact slice stored in R2.
 *
 * `updated_at` is kept alongside `created_at` so a consumer can tell a comment
 * that was edited since it was posted — directly relevant to the `edited`
 * webhook action. Fields are optional in the source; missing ones serialize to
 * `undefined` (omitted from JSON) rather than throwing.
 *
 * @param {{issue?:Array, review?:Array}|null} raw - `{ issue, review }` from getPrComments
 * @returns {{issue:Array<Object>, review:Array<Object>}}
 */
export function projectComments(raw) {
  return {
    issue: (raw?.issue || []).map((c) => ({
      user: c.user?.login,
      body: c.body,
      created_at: c.created_at,
      updated_at: c.updated_at,
    })),
    review: (raw?.review || []).map((c) => ({
      user: c.user?.login,
      body: c.body,
      path: c.path,
      line: c.line,
      updated_at: c.updated_at,
    })),
  };
}

/**
 * Full-refresh of the `comments` context slice.
 *
 * Re-fetches the PR's conversation via `getPrComments` and overwrites the
 * `comments.json` R2 object with the shared projection. This is the
 * incremental-update path for `issue_comment` created/edited/deleted events: it
 * keeps the slice fresh between gathers without re-fetching the diff/files.
 *
 * Properties:
 *  - **Idempotent** — a webhook re-delivery re-fetches the same comment set and
 *    writes identical bytes (never duplicates).
 *  - **Race-safe vs. the gather** — both writers use `projectComments`, so
 *    whichever lands last leaves a valid, consistently-shaped snapshot.
 *  - **Best-effort** — a GitHub or R2 failure is swallowed (the slice is
 *    derivative; the next gather re-captures it from scratch).
 *
 * @param {Object} args
 * @param {Object} args.github - GitHubClient (must implement getPrComments)
 * @param {Object} args.bucket - R2 bucket binding (env.BOT_ARTIFACTS)
 * @param {string} args.owner
 * @param {string} args.name
 * @param {number} args.prNumber
 * @param {number} args.repoId
 * @returns {Promise<{refreshed:boolean, issue?:number, review?:number}>}
 */
export async function refreshCommentsSlice({ github, bucket, owner, name, prNumber, repoId }) {
  if (!github?.getPrComments || !bucket?.put || repoId == null || prNumber == null) {
    return { refreshed: false };
  }
  const raw = await github
    .getPrComments(owner, name, prNumber, { maxComments: 100 })
    .catch(() => null);
  if (!raw) return { refreshed: false };

  const projected = projectComments(raw);
  await bucket
    .put(prContextKey(repoId, prNumber, 'comments'), JSON.stringify(projected), {
      httpMetadata: { contentType: 'application/json' },
    })
    .catch(() => {});
  return { refreshed: true, issue: projected.issue.length, review: projected.review.length };
}
