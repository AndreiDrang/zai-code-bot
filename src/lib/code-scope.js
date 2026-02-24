/**
 * Code scope extraction utilities.
 * Provides helpers for surrounding window extraction, target block extraction,
 * and nearest function/class block selection.
 * 
 * Uses deterministic bounds checking (1-indexed lines) and always returns
 * fallback objects instead of throwing errors.
 */

const { extractLines: contextExtractLines, validateRange } = require('./context');

const DEFAULT_WINDOW_SIZE = 15;

/**
 * Clamps a line number to valid bounds [1, maxLines].
 * @param {number} line - Line number to clamp
 * @param {number} maxLines - Maximum number of lines
 * @returns {number} Clamped line number
 */
function clampLine(line, maxLines) {
  return Math.max(1, Math.min(line, maxLines));
}

/**
 * Extracts target lines plus surrounding window (N lines before/after).
 * @param {string} content - File content
 * @param {number} startLine - Start line (1-indexed)
 * @param {number} endLine - End line (1-indexed)
 * @param {number} windowSize - Lines before/after to include (default: 15)
 * @returns {Object} Result with target, surrounding, bounds, and metadata
 */
function extractWindow(content, startLine, endLine, windowSize = DEFAULT_WINDOW_SIZE) {
  const lines = content.split('\n');
  const maxLines = lines.length;

  // Handle invalid input gracefully
  if (!content || typeof content !== 'string') {
    return {
      target: [],
      surrounding: null,
      bounds: { start: 1, end: 0, maxLines: 0 },
      fallback: true,
      note: 'Invalid content provided'
    };
  }

  // Validate and clamp target range
  const validTarget = validateRange(startLine, endLine, maxLines);
  if (!validTarget.valid) {
    // Return full file as fallback
    return {
      target: lines,
      surrounding: null,
      bounds: { start: 1, end: maxLines, maxLines },
      fallback: true,
      note: `Invalid target range: ${validTarget.error}. Returning full file.`
    };
  }

  // Calculate window bounds with clamping
  const windowStart = clampLine(startLine - windowSize, maxLines);
  const windowEnd = clampLine(endLine + windowSize, maxLines);

  // Extract surrounding window
  const surroundingResult = contextExtractLines(content, windowStart, windowEnd);
  const surrounding = surroundingResult.valid ? surroundingResult.lines : [];

  // Extract target within window
  const targetResult = contextExtractLines(content, startLine, endLine);
  const target = targetResult.valid ? targetResult.lines : [];

  return {
    target,
    surrounding,
    bounds: {
      start: windowStart,
      end: windowEnd,
      maxLines
    },
    fallback: false
  };
}

/**
 * Extracts exact line range from content.
 * Wrapper around context.extractLines with improved return shape.
 * @param {string} content - File content
 * @param {number} startLine - Start line (1-indexed)
 * @param {number} endLine - End line (1-indexed)
 * @returns {Object} Result with target, bounds, and metadata
 */
function extractTargetBlock(content, startLine, endLine) {
  const lines = content.split('\n');
  const maxLines = lines.length;

  // Handle invalid input gracefully
  if (!content || typeof content !== 'string') {
    return {
      target: [],
      bounds: { start: 1, end: 0, maxLines: 0 },
      fallback: true,
      note: 'Invalid content provided'
    };
  }

  // Validate range
  const validation = validateRange(startLine, endLine, maxLines);
  if (!validation.valid) {
    return {
      target: [],
      bounds: { start: 1, end: maxLines, maxLines },
      fallback: true,
      note: `Invalid range: ${validation.error}`
    };
  }

  // Extract exact lines
  const result = contextExtractLines(content, startLine, endLine);
  
  if (!result.valid) {
    return {
      target: [],
      bounds: { start: startLine, end: endLine, maxLines },
      fallback: true,
      note: result.error || 'Extraction failed'
    };
  }

  return {
    target: result.lines,
    bounds: { start: startLine, end: endLine, maxLines },
    fallback: false
  };
}

/**
 * Finds enclosing function/class block around an anchor line using simple heuristics.
 * Looks for: function declarations, class declarations, arrow functions, and { } matching.
 * @param {string} content - File content
 * @param {number} anchorLine - Line to find enclosing block for (1-indexed)
 * @param {Object} options - Optional configuration
 * @param {number} options.maxSearchLines - Max lines to search backward (default: 100)
 * @param {number} options.windowSize - Window size when returning fallback (default: 15)
 * @returns {Object} Result with target, bounds, and metadata
 */
function extractEnclosingBlock(content, anchorLine, options = {}) {
  const { maxSearchLines = 100, windowSize = DEFAULT_WINDOW_SIZE } = options;
  const lines = content.split('\n');
  const maxLines = lines.length;

  // Handle invalid input gracefully
  if (!content || typeof content !== 'string') {
    return {
      target: [],
      bounds: { start: 1, end: 0, maxLines: 0 },
      fallback: true,
      note: 'Invalid content provided'
    };
  }

  // Validate anchor line
  if (anchorLine < 1 || anchorLine > maxLines) {
    return extractWindow(content, Math.max(1, anchorLine - windowSize), Math.min(maxLines, anchorLine + windowSize), windowSize);
  }

  // Search for block start
  const blockStart = findBlockStart(lines, anchorLine, maxSearchLines);
  
  // Search for block end
  const blockEnd = findBlockEnd(lines, blockStart, anchorLine, maxLines);

  // Extract the block
  const result = contextExtractLines(content, blockStart, blockEnd);

  if (!result.valid) {
    // Fallback to window extraction
    const fallbackResult = extractWindow(content, anchorLine - windowSize, anchorLine + windowSize, windowSize);
    return {
      target: fallbackResult.target,
      bounds: fallbackResult.bounds,
      fallback: true,
      note: 'Could not determine block boundaries precisely, using window fallback'
    };
  }

  // Check if we actually found a meaningful block (not just the anchor line itself)
  const isMeaningfullyLarger = (blockEnd - blockStart) > (anchorLine - blockStart);
  
  if (!isMeaningfullyLarger) {
    // No real block found, return bounded local chunk
    const fallbackStart = clampLine(anchorLine - windowSize, maxLines);
    const fallbackEnd = clampLine(anchorLine + windowSize, maxLines);
    const fallbackResult = contextExtractLines(content, fallbackStart, fallbackEnd);
    
    return {
      target: fallbackResult.valid ? fallbackResult.lines : [],
      bounds: { start: fallbackStart, end: fallbackEnd, maxLines },
      fallback: true,
      note: 'No function/class block detected around anchor line, returning local context window'
    };
  }

  return {
    target: result.lines,
    bounds: { start: blockStart, end: blockEnd, maxLines },
    fallback: false
  };
}

/**
 * Find the start of a code block by searching backward for function/class declarations.
 * @param {string[]} lines - Array of lines
 * @param {number} anchorLine - Line to search around (1-indexed)
 * @param {number} maxSearch - Maximum lines to search backward
 * @returns {number} Line number where block starts (1-indexed)
 */
function findBlockStart(lines, anchorLine, maxSearch) {
  const startSearch = Math.max(1, anchorLine - maxSearch);
  
  // Keywords that indicate block starts
  const blockKeywords = [
    /^(\s*)(function\s+\w+|async\s+function|export\s+(default\s+)?function)/,
    /^(\s*)class\s+\w+/,
    /^(\s*)(\w+)\s*=\s*(async\s*)?\(/,  // function assigned to variable
    /^(\s*)(\w+)\s*:\s*.*=>/,            // object method arrow function
  ];

  // First, look for explicit block keywords near the anchor
  for (let i = anchorLine - 1; i >= startSearch; i--) {
    const line = lines[i - 1]; // Convert to 0-indexed
    
    // Check for block-opening keywords
    for (const keyword of blockKeywords) {
      if (keyword.test(line)) {
        return i;
      }
    }

    // Check for arrow function with =>
    if (line.includes('=>')) {
      // Find the start of this line (may be continuation)
      const trimmed = line.trim();
      if (trimmed.startsWith('=>') || /^\)\s*=>/.test(trimmed)) {
        // This is likely the end of an arrow function, search for its start
        const arrowStart = findArrowFunctionStart(lines, i);
        if (arrowStart > 0) {
          return arrowStart;
        }
      }
    }
  }

  // No explicit keyword found, search for { } matching
  // Look for { that might be a block start
  for (let i = anchorLine - 1; i >= startSearch; i--) {
    const line = lines[i - 1];
    const openBraces = (line.match(/{/g) || []).length;
    const closeBraces = (line.match(/}/g) || []).length;
    
    if (openBraces > closeBraces) {
      return i;
    }
  }

  // Default: return window start
  return Math.max(1, anchorLine - 10);
}

/**
 * Find the start of an arrow function given a line with =>.
 * @param {string[]} lines - Array of lines
 * @param {number} arrowLine - Line containing => (1-indexed)
 * @returns {number} Line where arrow function starts (1-indexed)
 */
function findArrowFunctionStart(lines, arrowLine) {
  // Search backward for the start of the arrow function
  // Look for patterns like: const x = (a, b) =>
  // or: (a, b) =>
  // or: a => 
  
  let parenDepth = 0;
  const searchStart = Math.max(1, arrowLine - 5);

  for (let i = arrowLine - 1; i >= searchStart; i--) {
    const line = lines[i - 1];
    
    parenDepth += (line.match(/\(/g) || []).length - (line.match(/\)/g) || []).length;
    
    // If we found the start (no open parens left and line ends with => or identifier)
    if (parenDepth <= 0) {
      const trimmed = line.trim();
      // Check if this looks like the start of an arrow function
      if (trimmed.endsWith('=>') || /^\(?[\w,\s]*\)?\s*=>/.test(trimmed)) {
        return i;
      }
    }
  }

  return arrowLine - 1;
}

/**
 * Find the end of a code block.
 * @param {string[]} lines - Array of lines
 * @param {number} blockStart - Where block starts (1-indexed)
 * @param {number} anchorLine - Original anchor line (1-indexed)
 * @param {number} maxLines - Maximum lines in file
 * @returns {number} Line where block ends (1-indexed)
 */
function findBlockEnd(lines, blockStart, anchorLine, maxLines) {
  // Simple { } matching to find block end
  let braceDepth = 0;
  let foundOpenBrace = false;
  const searchEnd = maxLines;

  for (let i = blockStart; i <= searchEnd; i++) {
    const line = lines[i - 1]; // Convert to 0-indexed
    
    const openBraces = (line.match(/{/g) || []).length;
    const closeBraces = (line.match(/}/g) || []).length;
    
    if (openBraces > 0) {
      foundOpenBrace = true;
    }
    
    if (foundOpenBrace) {
      braceDepth += openBraces - closeBraces;
      
      // Check for standalone close brace or end of block
      if (braceDepth <= 0) {
        return i;
      }
    }
  }

  // If no matching brace found, look for common block endings
  // Search for lines that typically end blocks
  for (let i = anchorLine; i <= searchEnd; i++) {
    const line = lines[i - 1];
    const trimmed = line.trim();
    
    // Common block endings
    if (trimmed === '}' || 
        trimmed.startsWith('}') ||
        /^\s*(return|throw|break|continue)\s+/.test(trimmed)) {
      return i;
    }
  }

  // Default: return anchor line or nearby
  return Math.min(maxLines, anchorLine + 20);
}

module.exports = {
  extractWindow,
  extractTargetBlock,
  extractEnclosingBlock,
  DEFAULT_WINDOW_SIZE,
};
