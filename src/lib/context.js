/**
 * Context budget and truncation utilities for prompt construction.
 * Provides deterministic file/diff selection and truncation policy.
 */

const DEFAULT_MAX_CHARS = 8000;
const TRUNCATION_MARKER = '...[truncated, N chars omitted]';

/**
 * Truncates content to maxChars with explicit truncation marker.
 * @param {string} content - The content to truncate
 * @param {number} maxChars - Maximum characters (default: 8000)
 * @returns {{ content: string, truncated: boolean, omitted: number }}
 */
function truncateContext(content, maxChars = DEFAULT_MAX_CHARS) {
  if (typeof content !== 'string') {
    throw new TypeError('content must be a string');
  }
  if (typeof maxChars !== 'number' || maxChars < 1) {
    throw new TypeError('maxChars must be a positive number');
  }

  if (content.length <= maxChars) {
    return { content, truncated: false, omitted: 0 };
  }

  const markerTemplate = TRUNCATION_MARKER;
  // Estimate: use 1 digit for N initially
  const estimatedMarkerLen = markerTemplate.length;
  const availableSpace = maxChars - estimatedMarkerLen;

  // Ensure we have positive space
  if (availableSpace <= 0) {
    const fullMarker = markerTemplate.replace('N', content.length);
    return { content: fullMarker, truncated: true, omitted: content.length };
  }

  let truncatedContent = content.slice(0, availableSpace);
  let omitted = content.length - availableSpace;

  // Adjust for variable marker length (number of digits in omitted count)
  const fullMarker = markerTemplate.replace('N', omitted);
  const actualMarkerLen = fullMarker.length;
  const adjustment = actualMarkerLen - estimatedMarkerLen;

  if (adjustment > 0) {
    // Need to trim more content to fit the longer marker
    const newAvailableSpace = Math.max(0, availableSpace - adjustment);
    truncatedContent = content.slice(0, newAvailableSpace);
    omitted = content.length - newAvailableSpace;
  }

  return {
    content: truncatedContent + markerTemplate.replace('N', omitted),
    truncated: true,
    omitted
  };
}

/**
 * Extracts a line range from content.
 * @param {string} content - The content to extract from
 * @param {number} startLine - Start line number (1-indexed)
 * @param {number} endLine - End line number (1-indexed)
 * @returns {{ lines: string[], valid: boolean, error?: string }}
 */
function extractLines(content, startLine, endLine) {
  if (typeof content !== 'string') {
    throw new TypeError('content must be a string');
  }

  const lines = content.split('\n');
  const maxLines = lines.length;

  // Validate range first
  const validation = validateRange(startLine, endLine, maxLines);
  if (!validation.valid) {
    return { lines: [], valid: false, error: validation.error };
  }

  // Extract lines (convert to 0-indexed, slice end is exclusive)
  const extracted = lines.slice(startLine - 1, endLine);

  return { lines: extracted, valid: true };
}

/**
 * Validates a line range.
 * @param {number} startLine - Start line number (1-indexed)
 * @param {number} endLine - End line number (1-indexed)
 * @param {number} maxLines - Maximum number of lines in the content
 * @returns {{ valid: boolean, error?: string }}
 */
function validateRange(startLine, endLine, maxLines) {
  if (typeof startLine !== 'number' || typeof endLine !== 'number' || typeof maxLines !== 'number') {
    return { valid: false, error: 'All parameters must be numbers' };
  }

  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || !Number.isInteger(maxLines)) {
    return { valid: false, error: 'All parameters must be integers' };
  }

  if (startLine < 1) {
    return { valid: false, error: `Start line must be >= 1, got ${startLine}` };
  }

  if (endLine > maxLines) {
    return { valid: false, error: `End line ${endLine} exceeds content max lines ${maxLines}` };
  }

  if (startLine > endLine) {
    return { valid: false, error: `Start line ${startLine} cannot exceed end line ${endLine}` };
  }

  return { valid: true };
}

/**
 * Gets the default maximum context size.
 * @returns {number} Default max characters
 */
function getDefaultMaxChars() {
  return DEFAULT_MAX_CHARS;
}

module.exports = {
  truncateContext,
  extractLines,
  validateRange,
  getDefaultMaxChars,
  DEFAULT_MAX_CHARS,
  TRUNCATION_MARKER
};



/**
 * Context builder error class for typed errors
 */
class ContextError extends Error {
  constructor(message, field) {
    super(message);
    this.name = 'ContextError';
    this.field = field;
    this.code = 'MISSING_FIELD';
  }
}

/**
 * Fetches changed files from a PR
 * @param {Object} octokit - GitHub Octokit instance
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @param {number} pullNumber - PR number
 * @returns {Promise<Array>} Array of changed file objects
 */
async function fetchChangedFiles(octokit, owner, repo, pullNumber) {
  const { data: files } = await octokit.rest.pulls.listFiles({
    owner,
    repo,
    pull_number: pullNumber,
    per_page: 100,
  });
  return files;
}

/**
 * Builds a normalized handler context from GitHub payload
 * Provides consistent fields for all command handlers
 * 
 * @param {Object} payload - GitHub event payload (github.context.payload)
 * @param {Object} octokit - GitHub Octokit instance
 * @param {Object} options - Optional configuration
 * @param {boolean} options.fetchFiles - Whether to fetch changed files (default: true)
 * @param {string} options.apiKey - Z.ai API key (from config)
 * @param {string} options.model - Z.ai model (from config)
 * @param {number} options.maxChars - Max characters for context (default: 8000)
 * @returns {Promise<Object>} Normalized handler context
 * 
 * @throws {ContextError} When required fields are missing
 * 
 * Context object contains:
 * - octokit: GitHub API client
 * - owner: Repository owner
 * - repo: Repository name
 * - pullNumber: PR number
 * - commentId: Comment ID (if from issue_comment)
 * - commentBody: Comment text
 * - sender: User who triggered the event
 * - changedFiles: Array of changed files (fetched from PR)
 * - payload: Raw event payload
 * - githubContext: GitHub context object
 * - maxChars: Context budget
 * - apiKey: Z.ai API key
 * - model: Z.ai model
 */
async function buildHandlerContext(payload, octokit, options = {}) {
  const fetchFiles = options.fetchFiles !== false;
  const apiKey = options.apiKey;
  const model = options.model || 'glm-4.7';
  const maxChars = options.maxChars || DEFAULT_MAX_CHARS;

  // Extract owner and repo from payload
  const owner = payload.repo?.owner?.login || payload.repository?.owner?.login;
  const repo = payload.repo?.name || payload.repository?.name;

  if (!owner) {
    throw new ContextError('Missing required field: owner', 'owner');
  }
  if (!repo) {
    throw new ContextError('Missing required field: repo', 'repo');
  }

  // Extract PR number from pull_request or issue (for issue_comment on PR)
  let pullNumber = payload.pull_request?.number;
  if (!pullNumber && payload.issue?.number && payload.issue?.pull_request) {
    pullNumber = payload.issue.number;
  }

  if (!pullNumber) {
    throw new ContextError('Missing required field: pullNumber (PR number)', 'pullNumber');
  }

  // Extract comment info (for issue_comment events)
  const commentId = payload.comment?.id;
  const commentBody = payload.comment?.body;

  // Extract sender (user who triggered the event)
  const sender = payload.sender?.login;

  if (!sender) {
    throw new ContextError('Missing required field: sender', 'sender');
  }

  // Build base context
  const context = {
    octokit,
    owner,
    repo,
    pullNumber,
    commentId,
    commentBody,
    sender,
    payload,
    maxChars,
    apiKey,
    model,
    // Legacy/compatibility fields
    issueNumber: pullNumber, // For handlers expecting issueNumber
  };

  // Fetch changed files if requested
  if (fetchFiles) {
    try {
      context.changedFiles = await fetchChangedFiles(octokit, owner, repo, pullNumber);
    } catch (error) {
      // Don't fail the entire context for file fetch errors
      context.changedFiles = [];
      context._fileFetchError = error.message;
    }
  }

  return context;
}

module.exports = {
  // Existing exports
  truncateContext,
  extractLines,
  validateRange,
  getDefaultMaxChars,
  DEFAULT_MAX_CHARS,
  TRUNCATION_MARKER,
  // New exports
  buildHandlerContext,
  fetchChangedFiles,
  ContextError,
};
