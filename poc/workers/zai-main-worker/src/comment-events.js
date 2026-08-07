/**
 * `issue_comment` event classification for the main worker.
 *
 * PR conversation comments are mirrored into the `comments` context slice
 * (see shared/pr-comments.js) so the heavy review/impact/ask/explain handlers
 * see fresh conversation between gathers. This module holds the PURE predicates
 * + the refresh-plan builder so they can be unit-tested without standing up the
 * webhook fetch handler.
 *
 * Only comments on a PULL REQUEST trigger a refresh (plain-issue comments have
 * no PR context tier to update). `deleted` is included alongside `created` /
 * `edited` because the full-refresh path removes deleted comments for free.
 */

export const COMMENT_REFRESH_ACTIONS = Object.freeze(['created', 'edited', 'deleted']);

/**
 * True when an `issue_comment` webhook should trigger a comments-slice refresh.
 *
 * Guards:
 *  - the event is literally `issue_comment` (not `pull_request_review_comment`,
 *    which is a separate event for inline review comments);
 *  - the action is one that changes the visible conversation;
 *  - the comment is on a PULL REQUEST (`issue.pull_request` is present);
 *  - the main worker has an R2 binding to write to.
 *
 * @param {string} ghEvent - raw `x-github-event` header value
 * @param {Object} webhookData - parsed webhook fields (issue, action, …)
 * @param {Object} env - worker env (checked for BOT_ARTIFACTS)
 * @returns {boolean}
 */
export function isPrCommentRefreshEvent(ghEvent, webhookData, env) {
  return (
    ghEvent === 'issue_comment' &&
    COMMENT_REFRESH_ACTIONS.includes(webhookData?.action) &&
    Boolean(webhookData?.issue?.pull_request) &&
    Boolean(env?.BOT_ARTIFACTS)
  );
}

/**
 * Builds the args for `refreshCommentsSlice` from a webhook payload. Returns
 * null when the repository / PR identity cannot be resolved.
 * @returns {{owner:string,name:string,prNumber:number,repoId:number}|null}
 */
export function planCommentsRefresh(webhookData) {
  const owner = webhookData?.repository?.owner?.login;
  const name = webhookData?.repository?.name;
  const prNumber = webhookData?.issue?.number;
  const repoId = webhookData?.repository?.id;
  if (!owner || !name || prNumber == null || repoId == null) return null;
  return { owner, name, prNumber, repoId };
}
