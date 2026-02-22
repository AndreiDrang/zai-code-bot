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
