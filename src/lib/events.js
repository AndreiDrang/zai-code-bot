/**
 * Event routing and anti-loop protection utilities
 * Handles GitHub webhook events for PR reviews and comments
 */

/**
 * Determines the type of GitHub event from the context
 * @param {Object} context - GitHub actions context object
 * @returns {string} Event type: 'pull_request', 'issue_comment_pr', or 'issue_comment_non_pr'
 */
function getEventType(context) {
  const eventName = context.eventName;

  if (eventName === 'pull_request') {
    return 'pull_request';
  }

  if (eventName === 'issue_comment') {
    // Check if the issue is a pull request by looking for pull_request property
    const issue = context.payload.issue;
    if (issue && issue.pull_request) {
      return 'issue_comment_pr';
    }
    return 'issue_comment_non_pr';
  }

  // Unknown event type - return as non-processable
  return 'issue_comment_non_pr';
}

/**
 * Checks if a comment was authored by a bot
 * @param {Object} comment - GitHub comment object
 * @returns {boolean} True if the comment author is a bot
 */
function isBotComment(comment) {
  if (!comment || !comment.user) {
    return false;
  }
  return comment.user.type === 'Bot';
}

/**
 * Determines whether an event should be processed based on event type and author
 * @param {Object} context - GitHub actions context object
 * @returns {Object} { process: boolean, reason: string }
 */
function shouldProcessEvent(context) {
  const eventType = getEventType(context);

  // Handle pull_request events - always process (existing behavior)
  if (eventType === 'pull_request') {
    return { process: true, reason: 'pull_request event' };
  }

  // Handle issue_comment on PRs
  if (eventType === 'issue_comment_pr') {
    const comment = context.payload.comment;

    // Check if comment is from a bot (anti-loop protection)
    if (isBotComment(comment)) {
      return { process: false, reason: 'bot comment - skipping to prevent loop' };
    }

    return { process: true, reason: 'issue_comment on pull request' };
  }

  // Handle non-PR issue comments - reject
  if (eventType === 'issue_comment_non_pr') {
    return { process: false, reason: 'non-PR issue comment - not supported' };
  }

  // Unknown event type - reject by default
  return { process: false, reason: `unknown event type: ${context.eventName}` };
}

/**
 * Extracts relevant information from context for routing decisions
 * @param {Object} context - GitHub actions context object
 * @returns {Object} Event info object
 */
function getEventInfo(context) {
  const eventType = getEventType(context);
  const { process, reason } = shouldProcessEvent(context);

  const info = {
    eventType,
    shouldProcess: process,
    reason,
    eventName: context.eventName,
  };

  // Add PR number if available
  if (context.payload.pull_request?.number) {
    info.pullNumber = context.payload.pull_request.number;
  } else if (context.payload.issue?.number) {
    info.pullNumber = context.payload.issue.number;
  }

  // Add comment info if available
  if (context.payload.comment) {
    info.commentId = context.payload.comment.id;
    info.commentAuthor = context.payload.comment.user?.login;
    info.isBot = isBotComment(context.payload.comment);
  }

  return info;
}

module.exports = {
  getEventType,
  isBotComment,
  shouldProcessEvent,
  getEventInfo,
};
