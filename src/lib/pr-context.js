/**
 * Shared PR context fetch module with reusable async helpers.
 * Provides functions for fetching PR files, file content at ref, and base/head refs.
 * All functions return structured responses with user-safe error fallbacks.
 */

const context = require('./context');
const logging = require('./logging');

// Default size limits
const DEFAULT_MAX_FILE_SIZE = 100000;
const DEFAULT_PER_PAGE = 100;

/**
 * User-safe fallback messages for common error types
 */
const FALLBACK_MESSAGES = {
  NOT_FOUND: 'Content not found',
  RATE_LIMITED: 'GitHub API rate limit exceeded. Please try again later.',
  PERMISSION_DENIED: 'Permission denied to access this resource.',
  UNAVAILABLE: 'Resource temporarily unavailable',
  UNKNOWN: 'Failed to retrieve content'
};

/**
 * Checks if error is a rate limit error (429)
 * @param {Error} error - Error to check
 * @returns {boolean} True if rate limit error
 */
function isRateLimitError(error) {
  const message = (error?.message || '').toLowerCase();
  return error?.status === 429 || message.includes('rate limit') || message.includes('secondary rate limit');
}

/**
 * Maps error to user-safe fallback message
 * @param {Error} error - Error to map
 * @param {string} resource - Resource being fetched (for context)
 * @returns {{fallback: string, category: string}} Fallback message and error category
 */
function mapErrorToFallback(error, resource = 'content') {
  if (error?.status === 404) {
    return { fallback: `${FALLBACK_MESSAGES.NOT_FOUND}: ${resource}`, category: 'NOT_FOUND' };
  }
  if (isRateLimitError(error)) {
    return { fallback: FALLBACK_MESSAGES.RATE_LIMITED, category: 'RATE_LIMIT' };
  }
  if (error?.status === 403) {
    return { fallback: FALLBACK_MESSAGES.PERMISSION_DENIED, category: 'PERMISSION' };
  }
  if (error?.status >= 500) {
    return { fallback: FALLBACK_MESSAGES.UNAVAILABLE, category: 'PROVIDER' };
  }
  return { fallback: FALLBACK_MESSAGES.UNKNOWN, category: 'UNKNOWN' };
}

/**
 * Fetches the list of files changed in a PR.
 * @param {Object} octokit - GitHub Octokit instance
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @param {number} pullNumber - PR number
 * @param {Object} [options={}] - Optional configuration
 * @param {number} [options.perPage=100] - Files per page
 * @returns {Promise<{success: boolean, data?: Array, error?: string, fallback?: string}>}
 */
async function fetchPrFiles(octokit, owner, repo, pullNumber, options = {}) {
  const perPage = options.perPage || DEFAULT_PER_PAGE;

  try {
    const { data } = await octokit.rest.pulls.listFiles({
      owner,
      repo,
      pull_number: pullNumber,
      per_page: perPage,
    });

    const files = Array.isArray(data) ? data : [];
    return { success: true, data: files };
  } catch (error) {
    const { fallback, category } = mapErrorToFallback(error, `files for PR #${pullNumber}`);

    // Log internal error details
    const internalLogger = logging.createLogger(logging.generateCorrelationId());
    internalLogger.warn(
      { status: error?.status, operation: 'pulls.listFiles', pullNumber },
      `Failed to fetch PR files: ${error.message}`
    );

    return { success: false, error: error.message, fallback };
  }
}

/**
 * Fetches file content at a specific ref (branch, tag, or SHA).
 * @param {Object} octokit - GitHub Octokit instance
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @param {string} path - File path in repository
 * @param {string} ref - Git ref (branch, tag, or SHA)
 * @param {Object} [options={}] - Optional configuration
 * @param {number} [options.maxFileSize=100000] - Maximum characters to return
 * @returns {Promise<{success: boolean, data?: string, error?: string, fallback?: string, truncated?: boolean}>}
 */
async function fetchFileAtRef(octokit, owner, repo, path, ref, options = {}) {
  const maxFileSize = options.maxFileSize || DEFAULT_MAX_FILE_SIZE;

  if (!path || !ref) {
    return {
      success: false,
      error: 'path and ref are required',
      fallback: FALLBACK_MESSAGES.VALIDATION || 'Invalid request parameters'
    };
  }

  try {
    const { data } = await octokit.rest.repos.getContent({
      owner,
      repo,
      path,
      ref,
    });

    // Handle directory or symlink responses
    if (!data || Array.isArray(data)) {
      return {
        success: false,
        error: `Path ${path} is a directory or not accessible`,
        fallback: `Content not available for ${path}`
      };
    }

    // Check for binary files or missing content
    if (!data.content) {
      return {
        success: false,
        error: 'File content not available (possibly binary)',
        fallback: `Binary or non-text content for ${path}`
      };
    }

    // Decode base64 content
    const decoded = Buffer.from(data.content, 'base64').toString('utf8');

    // Apply truncation if needed
    const truncated = context.truncateContext(decoded, maxFileSize);

    return {
      success: true,
      data: truncated.content,
      truncated: truncated.truncated,
      omitted: truncated.omitted
    };
  } catch (error) {
    const { fallback, category } = mapErrorToFallback(error, path);

    // Log internal error details
    const internalLogger = logging.createLogger(logging.generateCorrelationId());
    internalLogger.warn(
      { status: error?.status, operation: 'repos.getContent', path, ref },
      `Failed to fetch file content: ${error.message}`
    );

    return { success: false, error: error.message, fallback };
  }
}

/**
 * Resolves PR refs (base and head) from PR metadata.
 * @param {Object} octokit - GitHub Octokit instance
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @param {number} pullNumber - PR number
 * @returns {Promise<{success: boolean, data?: {base: {ref: string, sha: string}, head: {ref: string, sha: string}}, error?: string, fallback?: string}>}
 */
async function resolvePrRefs(octokit, owner, repo, pullNumber) {
  if (!pullNumber) {
    return {
      success: false,
      error: 'pullNumber is required',
      fallback: 'PR number is required'
    };
  }

  try {
    const { data } = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: pullNumber,
    });

    const baseRef = data.base?.ref;
    const baseSha = data.base?.sha;
    const headRef = data.head?.ref;
    const headSha = data.head?.sha;

    if (!baseRef || !baseSha || !headRef || !headSha) {
      return {
        success: false,
        error: 'PR base/head refs not found in response',
        fallback: 'PR ref information unavailable'
      };
    }

    return {
      success: true,
      data: {
        base: { ref: baseRef, sha: baseSha },
        head: { ref: headRef, sha: headSha }
      }
    };
  } catch (error) {
    const { fallback, category } = mapErrorToFallback(error, `PR #${pullNumber} metadata`);

    // Log internal error details
    const internalLogger = logging.createLogger(logging.generateCorrelationId());
    internalLogger.warn(
      { status: error?.status, operation: 'pulls.get', pullNumber },
      `Failed to resolve PR refs: ${error.message}`
    );

    return { success: false, error: error.message, fallback };
  }
}

/**
 * Fetches file content at the PR head commit.
 * Convenience wrapper around fetchFileAtRef using resolved head SHA.
 * @param {Object} octokit - GitHub Octokit instance
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @param {string} path - File path in repository
 * @param {number} pullNumber - PR number
 * @param {Object} [options={}] - Optional configuration
 * @param {number} [options.maxFileSize=100000] - Maximum characters to return
 * @returns {Promise<{success: boolean, data?: string, error?: string, fallback?: string, truncated?: boolean}>}
 */
async function fetchFileAtPrHead(octokit, owner, repo, path, pullNumber, options = {}) {
  // First resolve the head SHA
  const refsResult = await resolvePrRefs(octokit, owner, repo, pullNumber);

  if (!refsResult.success) {
    return {
      success: false,
      error: refsResult.error,
      fallback: refsResult.fallback
    };
  }

  // Fetch file at head
  return fetchFileAtRef(octokit, owner, repo, path, refsResult.data.head.sha, options);
}

module.exports = {
  fetchPrFiles,
  fetchFileAtRef,
  fetchFileAtPrHead,
  resolvePrRefs,
  isRateLimitError,
  mapErrorToFallback,
  DEFAULT_MAX_FILE_SIZE,
  DEFAULT_PER_PAGE,
  FALLBACK_MESSAGES
};
