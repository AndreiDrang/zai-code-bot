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

  // For fork PRs, check collaborator status
  // Non-collaborators are blocked silently (per SECURITY.md)
  if (!commenter || !commenter.login) {
    return {
      authorized: false,
      reason: null, // Silent block for fork PRs
    };
  }

  // Allow fork PR creator to use commands on their own PR.
  const pullRequestAuthor = pullRequest?.user?.login;
  if (pullRequestAuthor && commenter.login === pullRequestAuthor) {
    return {
      authorized: true,
    };
  }

  // Allow repository owner, admin, or maintainer to use commands on any PR (including Dependabot PRs)
  const repoOwner = context?.repo?.owner;
  
  // First check: is this user the repo owner?
  if (repoOwner && commenter.login === repoOwner) {
    return {
      authorized: true,
      reason: 'repo_owner',
    };
  }

  // Check collaborator permission (admin, maintain, write, or read)
  // This handles the case where repo owner wasn't detected but user has admin/maintainer perms
  const authResult = await checkAuthorization(octokit, context, commenter);
  
  // If authorized (any permission level including admin/maintainer), allow
  if (authResult.authorized) {
    return {
      authorized: true,
      reason: authResult.reason || 'collaborator',
    };
  }

  // For fork PRs from non-collaborators, silent block per SECURITY.md
  if (isFork) {
    return {
      authorized: false,
      reason: null, // Silent block
    };
  }

  // For non-fork PRs, return the authorization result (will show error to user)
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
  getPullRequestForAuthorization,
  isForkPullRequest,
  getUnauthorizedMessage,
  getUnknownCommandMessage,
  AUTHORIZED_PERMISSIONS,
  API_TIMEOUT_MS,
};
