export const SUPPORTED_PR_ACTIONS = Object.freeze([
  'opened',
  'reopened',
  'synchronize',
  'ready_for_review',
]);

export function isSupportedPullRequestEvent(event, action) {
  return event === 'pull_request' && SUPPORTED_PR_ACTIONS.includes(action);
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
