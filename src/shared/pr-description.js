import { prContextKey } from './storage/keys.js';

/**
 * Refresh the PR `description` context slice (`description.md`) from the PR's
 * `body`.
 *
 * The `description` slice has two writers: the eager gather (heavy worker),
 * which writes `getPullRequest().body` on each new head, and this incremental
 * refresh (main worker), which fires on `pull_request.edited` with
 * `changes.body`. The edited webhook carries the NEW body in the payload
 * itself (`pull_request.body`), so — unlike the comments refresh — this path
 * needs NO API fetch. Both writers store the same source value (`pullRequest.body`),
 * so last-writer-wins on the single R2 key leaves a consistent slice.
 */

/**
 * Writes `body` to the PR's `description.md` context object. Best-effort: an R2
 * failure is swallowed (the slice is derivative — the next gather re-captures
 * it). A null/missing body is coerced to '' to match the gather, so clearing the
 * PR description propagates correctly.
 *
 * @param {Object} args
 * @param {Object} args.bucket - R2 bucket binding (env.BOT_ARTIFACTS)
 * @param {number} args.repoId
 * @param {number} args.prNumber
 * @param {string|null} [args.body] - the PR body (description)
 * @returns {Promise<{refreshed:boolean, bytes?:number}>}
 */
export async function refreshDescriptionSlice({ bucket, repoId, prNumber, body }) {
  if (!bucket?.put || repoId == null || prNumber == null) {
    return { refreshed: false };
  }
  const text = typeof body === 'string' ? body : '';
  await bucket
    .put(prContextKey(repoId, prNumber, 'description'), text, {
      httpMetadata: { contentType: 'text/markdown' },
    })
    .catch(() => {});
  return { refreshed: true, bytes: text.length };
}
