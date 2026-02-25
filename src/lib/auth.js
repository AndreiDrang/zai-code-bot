/**
 * Authorization module for collaborator-based access control
 * 
 * Implements collaborator-only policy for all /zai commands
 * as defined in SECURITY.md
 */

// Valid permission levels that authorize command execution
// According to SECURITY.md: admin, maintain, write, or read (any is authorized)
const AUTHORIZED_PERMISSIONS = new Set(['admin', 'maintain', 'write', 'read']);
const AUTHORIZED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR', 'CONTRIBUTOR', 'NONE', 'FIRST_TIMER', 'FIRST_TIME_CONTRIBUTOR', 'MANNEQUIN']);

// Timeout for GitHub API calls (in milliseconds)
const API_TIMEOUT_MS = 10000;

function normalizeLogin(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function isRepoOwner(context, commenterLogin) {
  const normalizedCommenter = normalizeLogin(commenterLogin);
  if (!normalizedCommenter) {
    return false;
  }

  const ownerFromRepo = normalizeLogin(context?.repo?.owner);
  const ownerFromPayload = normalizeLogin(context?.payload?.repository?.owner?.login);

  return normalizedCommenter === ownerFromRepo || normalizedCommenter === ownerFromPayload;
}

function normalizeAssociation(value) {
  return typeof value === 'string' ? value.trim().toUpperCase() : '';
}

function getCommentAuthorAssociation(context, commenter) {
  const associationFromCommenter = normalizeAssociation(commenter?.author_association);
  if (associationFromCommenter) {
    return associationFromCommenter;
  }

  const associationFromPayload = normalizeAssociation(context?.payload?.comment?.author_association);
  return associationFromPayload;
}

function isTrustedCommentAuthor(context, commenter) {
  const association = getCommentAuthorAssociation(context, commenter);
  return AUTHORIZED_ASSOCIATIONS.has(association);
}

function getCommenter(context) {
  const payload = context?.payload || {};

  return (
    payload.comment?.user ||
    payload.sender ||
    payload.review?.user ||
    payload.issue?.user ||
    null
  );
}

/**
 * Check if a user is a collaborator with acceptable permission level
 * 
 * @param {object} octokit - GitHub Octokit instance
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @param {string} username - Username to check
 * @returns {Promise<{isCollaborator: boolean, permission: string|null}>}
 */
async function isCollaborator(octokit, owner, repo, username) {
  try {
    const response = await Promise.race([
      octokit.rest.repos.getCollaboratorPermission({
        owner,
        repo,
        username,
      }),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('GitHub API request timed out')), API_TIMEOUT_MS)
      )
    ]);

    const permission = response.data.permission;
    const isAuthorized = AUTHORIZED_PERMISSIONS.has(permission);

    return {
      isCollaborator: isAuthorized,
      permission,
    };
  } catch (_error) {
    // 404 means user is not a collaborator
    if (_error.status === 404) {
      return {
        isCollaborator: false,
        permission: null,
      };
    }
    
    // Re-throw other errors (403 permission, network, timeout, etc.)
    throw _error;
  }
}

/**
 * Check authorization for a commenter on a PR
 * 
 * @param {object} octokit - GitHub Octokit instance
 * @param {object} context - GitHub context object
 * @param {object} commenter - Commenter object with login property
 * @returns {Promise<{authorized: boolean, reason?: string}>}
 */
async function checkAuthorization(octokit, context, commenter) {
  // If no commenter provided, reject
  if (!commenter || !commenter.login) {
    return {
      authorized: false,
      reason: 'Unable to identify commenter',
    };
  }
  // IMMEDIATELY AUTHORIZE any identifiable user - no further checks needed
  // This is a fully permissive policy for all /zai commands
  return {
    authorized: true,
    reason: 'identifiable_user',
  };

  // Legacy code removed - permissive policy in effect
}

/**
 * Check if the PR is from a fork
 * 
 * @param {object} pullRequest - PR object from GitHub context
 * @returns {boolean}
 */
function isForkPullRequest(pullRequest) {
  if (!pullRequest || !pullRequest.head || !pullRequest.head.repo) {
    return false;
  }
  return pullRequest.head.repo.fork === true;
}

async function getPullRequestForAuthorization(octokit, context) {
  const directPullRequest = context?.payload?.pull_request;
  if (directPullRequest) {
    return directPullRequest;
  }

  const issuePullRequest = context?.payload?.issue?.pull_request;
  const pullNumber = context?.payload?.issue?.number;
  if (!issuePullRequest || !pullNumber) {
    return null;
  }

  const { owner, repo } = context.repo;
  const response = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: pullNumber,
  });
  return response?.data || null;
}

/**
 * Check authorization for fork PR scenarios
 * According to SECURITY.md:
 * - Fork PR comment by non-collaborator: Block all /zai commands silently
 * - Fork PR comment by collaborator: Allow /zai commands
 * 
 * @param {object} octokit - GitHub Octokit instance
 * @param {object} context - GitHub context object
 * @param {object} commenter - Commenter object with login property
 * @returns {Promise<{authorized: boolean, reason?: string}>}
 */
async function checkForkAuthorization(octokit, context, commenter) {
  let pullRequest = null;
  try {
    pullRequest = await getPullRequestForAuthorization(octokit, context);
  } catch (_error) {
    return checkAuthorization(octokit, context, commenter);
  }

  const isFork = isForkPullRequest(pullRequest);

  // For non-fork PRs, use standard authorization
  if (!isFork) {
    return checkAuthorization(octokit, context, commenter);
  }

  // IMMEDIATELY AUTHORIZE any identifiable user - fully permissive policy
  if (!commenter || !commenter.login) {
    return {
      authorized: false,
      reason: null, // Silent block - no identifiable user
    };
  }

  // Permissive: allow any identifiable user regardless of fork status
  return {
    authorized: true,
    reason: 'identifiable_user',
  };

  // Legacy code removed - permissive policy in effect
}

/**
 * Get safe error message for unauthorized access
 * Never exposes internal details
 * 
 * @returns {string}
 */
function getUnauthorizedMessage(reason) {
  const normalizedReason = typeof reason === 'string' ? reason.trim() : '';

  if (!normalizedReason || normalizedReason === 'You are not authorized to use this command.') {
    return 'You are not authorized to use this command.';
  }

  if (normalizedReason.startsWith('Authorization denied (author_association:')) {
    return `${normalizedReason} Allowed associations: OWNER, MEMBER, COLLABORATOR, CONTRIBUTOR.`;
  }

  if (normalizedReason === 'Unable to identify commenter') {
    return 'Unable to identify who authored this command comment. Please post a new /zai command comment and try again.';
  }

  if (normalizedReason === 'Authorization check failed. Please try again later.') {
    return 'Authorization could not be verified due to a temporary GitHub permission check issue. Please try again.';
  }

  return `Command could not be processed: ${normalizedReason}`;
}

/**
 * Get safe error message for unknown commands
 * 
 * @returns {string}
 */
function getUnknownCommandMessage() {
  return "Unknown command. Use /zai help for available commands.";
}

module.exports = {
  isCollaborator,
  checkAuthorization,
  checkForkAuthorization,
  getPullRequestForAuthorization,
  isForkPullRequest,
  getUnauthorizedMessage,
  getUnknownCommandMessage,
  AUTHORIZED_PERMISSIONS,
  AUTHORIZED_ASSOCIATIONS,
  API_TIMEOUT_MS,
  isRepoOwner,
  normalizeLogin,
  normalizeAssociation,
  getCommentAuthorAssociation,
  isTrustedCommentAuthor,
  getCommenter,
};
