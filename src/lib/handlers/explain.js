/**
 * Explain command handler for /zai explain <lines>
 * 
 * Parses line range, fetches file at PR head, extracts target + surrounding context,
 * and requests explanation from Z.ai API.
 */

const { validateRange, truncateContext, DEFAULT_MAX_CHARS } = require('../context');
const { fetchFileAtPrHead } = require('../pr-context');
const { extractWindow } = require('../code-scope');
const { REACTIONS, upsertComment, setReaction } = require('../comments');
const { createLogger, generateCorrelationId } = require('../logging');

const EXPLAIN_MARKER = '<!-- ZAI_EXPLAIN_COMMAND -->';

/**
 * Parse line range from command argument
 * Supports formats: "10-15", "10:15", "10..15"
 * @param {string} arg - Line range argument
 * @returns {{ startLine: number|null, endLine: number|null, error?: string }}
 */
function parseLineRange(arg) {
  if (!arg || typeof arg !== 'string') {
    return { startLine: null, endLine: null, error: 'No line range provided. Usage: /zai explain <start-end>' };
  }

  // Try different separators
  const match = arg.match(/^(\d+)([-:]|[.]{1,2})(\d+)$/);
  
  if (!match) {
    return { 
      startLine: null, 
      endLine: null, 
      error: `Invalid line range format: "${arg}". Use format: /zai explain 10-15` 
    };
  }

  const startLine = parseInt(match[1], 10);
  const endLine = parseInt(match[3], 10);

  if (startLine < 1) {
    return { startLine: null, endLine: null, error: `Start line must be >= 1, got ${startLine}` };
  }

  if (startLine > endLine) {
    return { startLine: null, endLine: null, error: `Start line ${startLine} cannot exceed end line ${endLine}` };
  }

  return { startLine, endLine };
}

/**
 * Build explanation prompt with extracted lines and surrounding context
 * @param {string} filename - File being explained
 * @param {Object|Array} scopeResult - Result from extractWindow OR legacy lines array
 * @param {number} startLine - Start line number
 * @param {number} endLine - End line number
 * @param {number} maxChars - Maximum prompt characters
 * @returns {{ prompt: string, truncated: boolean }}
 */
function buildExplainPrompt(filename, scopeResult, startLine, endLine, maxChars = DEFAULT_MAX_CHARS) {
  // Handle backward compatibility: if scopeResult is an array (old format), wrap it
  let target, surrounding;
  
  if (Array.isArray(scopeResult)) {
    // Legacy format: scopeResult is the lines array
    target = scopeResult;
    surrounding = scopeResult; // No surrounding context in legacy format
  } else {
    // New format: scopeResult is extractWindow result
    target = scopeResult.target || [];
    surrounding = scopeResult.surrounding || [];
  }

  const targetContent = target.join('\n');
  const surroundingContent = surrounding.join('\n');
  
  // Include filename in the prompt for clarity
  let prompt = `Explain the following code block from file: ${filename}\n`;
  prompt += `Context (Surrounding Code):\n`;
  prompt += `<surrounding_scope>\n${surroundingContent}\n</surrounding_scope>\n\n`;
  prompt += `Target block to explain:\n`;
  prompt += `<target_lines>${startLine}-${endLine}</target_lines>\n`;
  prompt += `<code>\n${targetContent}\n</code>\n\n`;
  prompt += `Task: Explain what this specific block does, why it's written this way, and identify any dependencies it uses from the surrounding scope.`;
  
  const truncated = truncateContext(prompt, maxChars);
  return { prompt: truncated.content, truncated: truncated.truncated };
}

/**
 * Handle the /zai explain command
 * @param {Object} context - Application context
 * @param {Object} context.octokit - GitHub Octokit instance
 * @param {string} context.owner - Repository owner
 * @param {string} context.repo - Repository name
 * @param {number} context.issueNumber - PR number
 * @param {string} context.commentPath - File path from command comment (if specified)
 * @param {string} context.filename - Fallback file name
 * @param {Array} context.changedFiles - List of changed files in PR
 * @param {Object} context.apiClient - Z.ai API client
 * @param {string} context.apiKey - Z.ai API key
 * @param {string} context.model - Z.ai model to use
 * @param {Object} context.logger - Logger instance
 * @param {string[]} args - Command arguments (line range)
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function handleExplainCommand(context, args) {
  const { octokit, owner, repo, issueNumber, commentPath, filename, changedFiles, apiClient, apiKey, model, commentId } = context;
  const logger = context.logger || createLogger(generateCorrelationId(), { command: 'explain' });
  const commentOptions = {
    replyToId: commentId,
    updateExisting: false,
    isReviewComment: Boolean(context.isReviewComment),
    pullNumber: context.pullNumber || issueNumber,
  };

  if (!args || args.length === 0) {
    await upsertComment(
      octokit, owner, repo, issueNumber,
      `**Error:** No line range provided. Usage: /zai explain 10-15`,
      EXPLAIN_MARKER,
      commentOptions
    );
    // Add error reaction if commentId available
    if (commentId) {
      await setReaction(octokit, owner, repo, commentId, REACTIONS.X);
    }
    return { success: false, error: 'No line range provided' };
  }

  // Step 1: Parse line range
  const parsed = parseLineRange(args[0]);
  if (parsed.error) {
    await upsertComment(
      octokit, owner, repo, issueNumber,
      `**Error:** ${parsed.error}`,
      EXPLAIN_MARKER,
      commentOptions
    );
    // Add error reaction if commentId available
    if (commentId) {
      await setReaction(octokit, owner, repo, commentId, REACTIONS.X);
    }
    return { success: false, error: parsed.error };
  }

  const { startLine, endLine } = parsed;

  // Step 2: Determine target file path
  // Use commentPath if provided, otherwise use filename or first changed file
  const targetPath = commentPath || filename;
  
  // If no path available, try to get first changed file
  let resolvedPath = targetPath;
  if (!resolvedPath && changedFiles && changedFiles.length > 0) {
    resolvedPath = changedFiles[0].filename;
  }

  if (!resolvedPath) {
    await upsertComment(
      octokit, owner, repo, issueNumber,
      `**Error:** No target file specified. Usage: /zai explain 10-15`,
      EXPLAIN_MARKER,
      commentOptions
    );
    if (commentId) {
      await setReaction(octokit, owner, repo, commentId, REACTIONS.X);
    }
    return { success: false, error: 'No target file specified' };
  }

  logger.info({ startLine, endLine, path: resolvedPath }, 'Parsed line range, fetching file at PR head');

  // Step 3: Fetch file content at PR head
  const fileResult = await fetchFileAtPrHead(octokit, owner, repo, resolvedPath, issueNumber, {
    maxFileLines: 10000,
    changedRanges: [{ start: startLine, end: endLine }],
    windowSize: 20,
    maxWindows: 1,
  });
  
  if (!fileResult.success) {
    const errorMsg = fileResult.fallback || `Failed to fetch ${resolvedPath}`;
    await upsertComment(
      octokit, owner, repo, issueNumber,
      `**Error:** ${errorMsg}`,
      EXPLAIN_MARKER,
      commentOptions
    );
    if (commentId) {
      await setReaction(octokit, owner, repo, commentId, REACTIONS.X);
    }
    return { success: false, error: errorMsg };
  }

  const fileContent = fileResult.data;
  const maxLines = Number.isFinite(fileResult.lineCount)
    ? fileResult.lineCount
    : fileContent.split('\n').length;

  // Step 4: Validate line range against actual file line count
  const validation = validateRange(startLine, endLine, maxLines);
  if (!validation.valid) {
    await upsertComment(
      octokit, owner, repo, issueNumber,
      `**Error:** ${validation.error}. File has ${maxLines} lines.`,
      EXPLAIN_MARKER,
      commentOptions
    );
    // Add error reaction if commentId available
    if (commentId) {
      await setReaction(octokit, owner, repo, commentId, REACTIONS.X);
    }
    return { success: false, error: validation.error };
  }

  // Step 5: Extract target + surrounding context using extractWindow
  let scopedStart = startLine;
  let scopedEnd = endLine;

  if (fileResult.scoped && Number.isFinite(fileResult.scopeStartLine)) {
    scopedStart = startLine - fileResult.scopeStartLine + 1;
    scopedEnd = endLine - fileResult.scopeStartLine + 1;
  }

  const scopeResult = extractWindow(fileContent, scopedStart, scopedEnd);
  
  if (scopeResult.fallback) {
    logger.warn({ note: scopeResult.note }, 'Using fallback for scope extraction');
  }

  logger.info({ 
    targetLines: scopeResult.target.length, 
    surroundingLines: scopeResult.surrounding.length 
  }, 'Extracted target and surrounding context');

  // Step 6: Build prompt with scope result
  const { prompt, truncated } = buildExplainPrompt(resolvedPath, scopeResult, startLine, endLine);

  // Step 7: Call Z.ai API
  try {
    logger.info({ path: resolvedPath, startLine, endLine }, 'Calling Z.ai API for explanation');

    const result = await apiClient.call({
      apiKey,
      model,
      prompt
    });

    if (!result.success) {
      const errorMsg = result.error?.message || 'Failed to get explanation';
      logger.warn({ error: errorMsg, retry: true }, 'API call failed, retrying with compact explain prompt');

      const compactScope = {
        target: scopeResult.target,
        surrounding: scopeResult.target,
      };
      const compact = buildExplainPrompt(resolvedPath, compactScope, startLine, endLine, Math.min(DEFAULT_MAX_CHARS, 3000));
      const retryResult = await apiClient.call({
        apiKey,
        model,
        prompt: compact.prompt,
      });

      if (!retryResult.success) {
        const retryErrorMsg = retryResult.error?.message || errorMsg;
        logger.error({ error: retryErrorMsg }, 'Explain retry API call failed');
        await upsertComment(
          octokit, owner, repo, issueNumber,
          `**Error:** ${retryErrorMsg}`,
          EXPLAIN_MARKER,
          commentOptions
        );
        if (commentId) {
          await setReaction(octokit, owner, repo, commentId, REACTIONS.X);
        }
        return { success: false, error: retryErrorMsg };
      }

      let retryResponse = retryResult.data;
      if (compact.truncated) {
        retryResponse += '\n\n_(Note: Compact context was used due to model limits)_';
      }

      const retryFormatted = `## 📖 Explanation: ${resolvedPath}:${startLine}-${endLine}\n\n${retryResponse}`;
      await upsertComment(
        octokit, owner, repo, issueNumber,
        retryFormatted,
        EXPLAIN_MARKER,
        commentOptions
      );
      // Add error reaction if commentId available
      if (commentId) {
        await setReaction(octokit, owner, repo, commentId, REACTIONS.ROCKET);
      }
      return { success: true };
    }

    let response = result.data;

    if (truncated) {
      response += '\n\n_(Note: Context was truncated due to size limits)_';
    }

    const formattedResponse = `## 📖 Explanation: ${resolvedPath}:${startLine}-${endLine}\n\n${response}`;

    await upsertComment(
      octokit, owner, repo, issueNumber,
      formattedResponse,
      EXPLAIN_MARKER,
      commentOptions
    );

    // Add success reaction if commentId available
    if (commentId) {
      await setReaction(octokit, owner, repo, commentId, REACTIONS.ROCKET);
    }

    logger.info({ path: resolvedPath, startLine, endLine }, 'Explanation posted successfully');
    return { success: true };

  } catch (error) {
    logger.error({ error: error.message }, 'Explain command failed');

    await upsertComment(
      octokit, owner, repo, issueNumber,
      `**Error:** Failed to complete explanation. Please try again later.`,
      EXPLAIN_MARKER,
      commentOptions
    );

    // Add error reaction if commentId available
    if (commentId) {
      await setReaction(octokit, owner, repo, commentId, REACTIONS.X);
    }

    return { success: false, error: error.message };
  }
}

module.exports = {
  handleExplainCommand,
  parseLineRange,
  buildExplainPrompt,
  EXPLAIN_MARKER,
};
