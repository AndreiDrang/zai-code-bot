/**
 * Shared PR context fetch module with reusable async helpers.
 * Provides functions for fetching PR files, file content at ref, and base/head refs.
 * All functions return structured responses with user-safe error fallbacks.
 */

const context = require('./context');
const logging = require('./logging');
const { extractEnclosingBlock } = require('./code-scope');

// Default size limits
const DEFAULT_MAX_FILE_SIZE = 100000;
const DEFAULT_MAX_FILE_LINES = 10000;
const DEFAULT_PER_PAGE = 100;
const DEFAULT_SLIDING_WINDOW = 40;
const DEFAULT_MAX_WINDOWS = 4;

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

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function parsePatchLineRanges(patch, side = 'new') {
  if (!patch || typeof patch !== 'string') {
    return [];
  }

  const ranges = [];
  const regex = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/gm;
  let match = regex.exec(patch);
  while (match !== null) {
    const start = side === 'old' ? Number(match[1]) : Number(match[3]);
    const countRaw = side === 'old' ? match[2] : match[4];
    const count = countRaw ? Number(countRaw) : 1;
    const safeCount = Number.isFinite(count) ? Math.max(1, count) : 1;
    const end = start + safeCount - 1;
    if (Number.isFinite(start) && start >= 1) {
      ranges.push({ start, end });
    }
    match = regex.exec(patch);
  }

  return ranges;
}

function buildSlidingWindowsContent(content, changedRanges, options = {}) {
  const windowSize = options.windowSize || DEFAULT_SLIDING_WINDOW;
  const maxWindows = options.maxWindows || DEFAULT_MAX_WINDOWS;
  const lines = String(content).split('\n');
  const maxLines = lines.length;

  const windows = (changedRanges || [])
    .map((range) => {
      const start = clamp(range.start - windowSize, 1, maxLines);
      const end = clamp(range.end + windowSize, 1, maxLines);
      return { start, end };
    })
    .sort((a, b) => a.start - b.start);

  const merged = [];
  for (const window of windows) {
    const last = merged[merged.length - 1];
    if (!last || window.start > last.end + 1) {
      merged.push({ ...window });
      continue;
    }
    last.end = Math.max(last.end, window.end);
  }

  const selected = merged.slice(0, maxWindows);
  if (selected.length === 1) {
    const only = selected[0];
    return {
      content: lines.slice(only.start - 1, only.end).join('\n'),
      scopeStrategy: 'sliding_window',
      scopeStartLine: only.start,
      scopeEndLine: only.end,
    };
  }

  const chunks = selected.map((window, idx) => {
    const snippet = lines.slice(window.start - 1, window.end).join('\n');
    return `# Window ${idx + 1} (lines ${window.start}-${window.end})\n${snippet}`;
  });

  if (chunks.length === 0) {
    const fallbackEnd = clamp(windowSize * 2, 1, maxLines);
    return {
      content: lines.slice(0, fallbackEnd).join('\n'),
      scopeStrategy: 'top_window',
      scopeStartLine: 1,
      scopeEndLine: fallbackEnd,
    };
  }

  return {
    content: chunks.join('\n\n---\n\n'),
    scopeStrategy: 'sliding_window',
    scopeStartLine: selected.length === 1 ? selected[0].start : null,
    scopeEndLine: selected.length === 1 ? selected[0].end : null,
  };
}

function scopeLargeFileContent(content, options = {}) {
  const lines = String(content).split('\n');
  const lineCount = lines.length;
  const maxFileLines = options.maxFileLines || DEFAULT_MAX_FILE_LINES;

  if (lineCount <= maxFileLines) {
    return {
      scoped: false,
      scopeStrategy: 'full_file',
      content,
      lineCount,
      scopeStartLine: 1,
      scopeEndLine: lineCount,
    };
  }

  const anchorLine = options.anchorLine;
  const preferEnclosingBlock = Boolean(options.preferEnclosingBlock);
  let changedRanges = options.changedRanges;
  if ((!changedRanges || changedRanges.length === 0) && options.patch) {
    changedRanges = parsePatchLineRanges(options.patch, options.patchSide || 'new');
  }

  if (preferEnclosingBlock && Number.isFinite(anchorLine) && anchorLine >= 1) {
    const block = extractEnclosingBlock(content, anchorLine, {
      windowSize: options.windowSize || DEFAULT_SLIDING_WINDOW,
    });

    return {
      scoped: true,
      scopeStrategy: 'enclosing_block',
      content: block.target.join('\n'),
      lineCount,
      scopeStartLine: block?.bounds?.start || null,
      scopeEndLine: block?.bounds?.end || null,
      note: block.note,
    };
  }

  if (Array.isArray(changedRanges) && changedRanges.length > 0) {
    const scoped = buildSlidingWindowsContent(content, changedRanges, {
      windowSize: options.windowSize,
      maxWindows: options.maxWindows,
    });
    return {
      scoped: true,
      lineCount,
      ...scoped,
    };
  }

  const topFallback = buildSlidingWindowsContent(content, [], {
    windowSize: options.windowSize,
    maxWindows: 1,
  });

  return {
    scoped: true,
    lineCount,
    ...topFallback,
  };
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
  const maxFileLines = options.maxFileLines || DEFAULT_MAX_FILE_LINES;

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

    const scopedResult = scopeLargeFileContent(decoded, {
      maxFileLines,
      anchorLine: options.anchorLine,
      preferEnclosingBlock: options.preferEnclosingBlock,
      changedRanges: options.changedRanges,
      patch: options.patch,
      patchSide: options.patchSide,
      windowSize: options.windowSize,
      maxWindows: options.maxWindows,
    });

    // Apply truncation if needed
    const truncated = context.truncateContext(scopedResult.content, maxFileSize);

    return {
      success: true,
      data: truncated.content,
      truncated: truncated.truncated,
      omitted: truncated.omitted,
      scoped: scopedResult.scoped,
      scopeStrategy: scopedResult.scopeStrategy,
      lineCount: scopedResult.lineCount,
      scopeStartLine: scopedResult.scopeStartLine,
      scopeEndLine: scopedResult.scopeEndLine,
      scopeNote: scopedResult.note,
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
  DEFAULT_MAX_FILE_LINES,
  DEFAULT_PER_PAGE,
  DEFAULT_SLIDING_WINDOW,
  FALLBACK_MESSAGES,
  parsePatchLineRanges,
  scopeLargeFileContent,
};
