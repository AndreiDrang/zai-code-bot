/**
 * Actions that introduce a NEW head SHA worth gathering PR context for.
 * The gather handler is itself idempotent per head via the R2 manifest, so this
 * avoids pointless job rows and queue round-trips.
 */
export const CONTEXT_TRIGGER_ACTIONS = Object.freeze([
  'opened',
  'reopened',
  'synchronize',
  'ready_for_review',
]);

/**
 * Gate for the durable PR-context path.
 */
export function isSupportedPullRequestEvent(event, action) {
  return event === 'pull_request' && CONTEXT_TRIGGER_ACTIONS.includes(action);
}

/**
 * True when a `pull_request.edited` webhook changed the PR body (description)
 * and there is an R2 binding to write to.
 *
 * A body edit refreshes the `description` context slice so the review and
 * describe handlers see the latest PR description between gathers.
 *
 * @param {string} event - raw `x-github-event` header
 * @param {string} action
 * @param {Object} payload - raw webhook payload (carries `changes` + the full PR)
 * @param {Object} env - worker env (checked for BOT_ARTIFACTS)
 * @returns {boolean}
 */
export function isPrDescriptionEditEvent(event, action, payload, env) {
  return (
    event === 'pull_request' &&
    action === 'edited' &&
    Boolean(payload?.changes?.body) &&
    Boolean(env?.BOT_ARTIFACTS)
  );
}

/**
 * Builds the args for `refreshDescriptionSlice` from an edited webhook. The
 * post-edit body is carried IN the payload (`pull_request.body`), so NO API
 * fetch is needed — unlike the comments refresh, where one webhook carries a
 * single comment, not the whole conversation. A null/missing body is coerced
 * to '' to match the gather (`pullRequest?.body || ''`), so clearing the PR
 * description propagates. Returns null when identity cannot be resolved.
 * @returns {{repoId:number, prNumber:number, body:string}|null}
 */
export function planDescriptionRefresh(payload) {
  const repoId = payload?.repository?.id;
  const prNumber = payload?.pull_request?.number;
  if (repoId == null || prNumber == null) return null;
  return { repoId, prNumber, body: payload?.pull_request?.body ?? '' };
}

export function extractPullRequestEvent(payload, deliveryId, action = payload?.action) {
  const repository = payload?.repository;
  const pullRequest = payload?.pull_request;
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
  };
}
