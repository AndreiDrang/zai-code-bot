/**
 * Authorization module for collaborator-based access control
 * 
 * Implements collaborator-only policy for all /zai commands
 * as defined in SECURITY.md
 */

// Valid permission levels that authorize command execution
// According to SECURITY.md: admin, maintain, write, or read (any is authorized)
const AUTHORIZED_PERMISSIONS = new Set(['admin', 'maintain', 'write', 'read']);

// Timeout for GitHub API calls (in milliseconds)
const API_TIMEOUT_MS = 10000;

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

  const { owner, repo } = context.repo;

  try {
    const result = await isCollaborator(octokit, owner, repo, commenter.login);

    if (result.isCollaborator) {
      return {
        authorized: true,
      };
    }

    // User is not authorized
    return {
      authorized: false,
      reason: 'You are not authorized to use this command.',
    };
  } catch (_error) {
    // Handle API errors gracefully - deny access on error for security
    // Never expose internal error details to users
    return {
      authorized: false,
      reason: 'Authorization check failed. Please try again later.',
    };
  }
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
  const pullRequest = context.payload.pull_request;
  const isFork = isForkPullRequest(pullRequest);

  // For non-fork PRs, use standard authorization
  if (!isFork) {
    return checkAuthorization(octokit, context, commenter);
  }

  // For fork PRs, check collaborator status
  // Non-collaborators are blocked silently (per SECURITY.md)
  if (!commenter || !commenter.login) {
    return {
      authorized: false,
      reason: null, // Silent block for fork PRs
    };
  }

  const authResult = await checkAuthorization(octokit, context, commenter);
  
  // If not authorized on fork PR, silent block
  if (!authResult.authorized) {
    return {
      authorized: false,
      reason: null, // Silent block for fork PRs
    };
  }

  return authResult;
}

/**
 * Get safe error message for unauthorized access
 * Never exposes internal details
 * 
 * @returns {string}
 */
function getUnauthorizedMessage() {
  return 'You are not authorized to use this command.';
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
  isForkPullRequest,
  getUnauthorizedMessage,
  getUnknownCommandMessage,
  AUTHORIZED_PERMISSIONS,
  API_TIMEOUT_MS,
};
