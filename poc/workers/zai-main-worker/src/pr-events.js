export const SUPPORTED_PR_ACTIONS = Object.freeze([
  'opened',
  'reopened',
  'synchronize',
  'ready_for_review',
  'edited',
  'closed',
]);

/**
 * Actions that introduce a NEW head SHA worth gathering PR context for.
 * `edited` (title change) and `closed` carry no new content, so the eager
 * pr_context job is created only for these. (The gather handler is itself
 * idempotent per head via the R2 manifest, so this is an optimization that
 * avoids pointless job rows + queue round-trips, not a correctness gate.)
 */
export const CONTEXT_TRIGGER_ACTIONS = Object.freeze([
  'opened',
  'reopened',
  'synchronize',
  'ready_for_review',
]);

/**
 * Gate for the durable PR-preview path.
 *
 * `edited` fires for title, body, and base changes, but the preview is
 * metadata-only (repository / PR / title / author / head) — only a title
 * change affects it. Accepting every edit would re-render identical content
 * (a wasted R2 write + comment PATCH + KV put), so `edited` is gated on
 * `changes.title`. `payload` is optional for the non-edited actions.
 */
export function isSupportedPullRequestEvent(event, action, payload = null) {
  if (event !== 'pull_request' || !SUPPORTED_PR_ACTIONS.includes(action)) return false;
  if (action === 'edited') return Boolean(payload?.changes?.title);
  return true;
}

export function extractPullRequestEvent(payload, deliveryId, action = payload?.action) {
  const repository = payload?.repository;
  const pullRequest = payload?.pull_request;
  const sender = payload?.sender;
  if (!repository || !pullRequest || !deliveryId) return null;
  return {
    deliveryId,
    action,
    repositoryId: repository.id,
    repository: {
      owner: repository.owner?.login || repository.owner?.name,
      name: repository.name,
      fullName: repository.full_name,
      defaultBranch: repository.default_branch,
    },
    prNumber: pullRequest.number,
    headSha: pullRequest.head?.sha,
    baseSha: pullRequest.base?.sha,
    title: pullRequest.title,
    authorLogin: pullRequest.user?.login,
    state: pullRequest.state,
    // Who closed the PR — only meaningful for `closed` (the webhook `sender`).
    // Captured once here so the async heavy worker can render "closed by @X"
    // without an extra API call: GitHub's PR API does not expose closed_by.
    closedBy: action === 'closed' ? sender?.login : null,
  };
}
