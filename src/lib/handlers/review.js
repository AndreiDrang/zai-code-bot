/**
 * Review command handler for /zai review
 * 
 * Validates file is in PR changed files and builds targeted review prompt.
 */

const { truncateContext, DEFAULT_MAX_CHARS } = require('../context');
const { REACTIONS, upsertComment, setReaction } = require('../comments');
const { createLogger, generateCorrelationId } = require('../logging');

// Marker for identifying review comments
const REVIEW_MARKER = '<!-- ZAI_REVIEW_COMMAND -->';

/**
 * Parse file path from command arguments
 * @param {string[]} args - Command arguments
 * @returns {{ filePath: string|null, error?: string }}
 */
function parseFilePath(args) {
  if (!args || args.length === 0) {
    return { filePath: null, error: 'No file path provided. Usage: /zai review <filepath>' };
  }
  
  const filePath = args.join('/');
  
  // Basic validation - no path traversal attempts
  if (filePath.includes('..') || filePath.startsWith('/')) {
    return { filePath: null, error: 'Invalid file path. Path traversal is not allowed.' };
  }
  
  return { filePath };
}

/**
 * Check if a file is in the PR's changed files
 * @param {string} filePath - The file path to check
 * @param {Array} changedFiles - Array of changed file objects from PR
 * @returns {{ valid: boolean, error?: string, file?: object }}
 */
function validateFileInPr(filePath, changedFiles) {
  if (!changedFiles || !Array.isArray(changedFiles)) {
    return { valid: false, error: 'Unable to get PR changed files list' };
  }
  
  // Try to find the file - check both filename and full path
  const normalizedInputPath = filePath.replace(/^\//, '').toLowerCase();
  
  const foundFile = changedFiles.find(file => {
    const filename = file.filename?.toLowerCase();
    return filename === normalizedInputPath || 
           filename?.endsWith(`/${normalizedInputPath}`);
  });
  
  if (!foundFile) {
    const availableFiles = changedFiles.map(f => f.filename).join(', ');
    return { 
      valid: false, 
      error: `File "${filePath}" not found in PR changed files. Available files: ${availableFiles}` 
    };
  }
  
  return { valid: true, file: foundFile };
}

/**
 * Build review prompt for a specific file
 * @param {object} file - The file object from PR changes
 * @param {number} maxChars - Maximum characters for prompt
 * @returns {{ prompt: string, truncated: boolean }}
 */
function buildReviewPrompt(file, maxChars = DEFAULT_MAX_CHARS) {
  const { filename, patch, status } = file;
  
  let content = `Please review the following code change in file: ${filename}\n`;
  content += `Change type: ${status}\n\n`;
  
  if (patch) {
    content += `--- DIFF ---\n${patch}\n--- END DIFF ---`;
  } else {
    content += '(No diff available - file may be binary or too large)';
  }
  
  const truncated = truncateContext(content, maxChars);
  return { prompt: truncated.content, truncated: truncated.truncated };
}

/**
 * Handle the /zai review command
 * @param {Object} context - Application context
 * @param {Object} context.octokit - GitHub Octokit instance
 * @param {string} context.owner - Repository owner
 * @param {string} context.repo - Repository name
 * @param {number} context.issueNumber - PR number
 * @param {Array} context.changedFiles - Changed files in PR
 * @param {Object} context.apiClient - Z.ai API client
 * @param {string} context.apiKey - Z.ai API key
 * @param {string} context.model - Z.ai model to use
 * @param {Object} context.logger - Logger instance
 * @param {string[]} args - Command arguments (file path)
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function handleReviewCommand(context, args) {
  const { octokit, owner, repo, issueNumber, changedFiles, apiClient, apiKey, model, commentId } = context;
  const logger = context.logger || createLogger(generateCorrelationId(), { command: 'review' });
  
  // Step 1: Parse file path from args
  const parsed = parseFilePath(args);
  if (parsed.error) {
    await upsertComment(
      octokit, owner, repo, issueNumber,
      `**Error:** ${parsed.error}`,
      REVIEW_MARKER,
      { replyToId: commentId, updateExisting: false }
    );
    // Add error reaction if commentId available
    if (commentId) {
      await setReaction(octokit, owner, repo, commentId, REACTIONS.X);
    }
    return { success: false, error: parsed.error };
  }
  
  const filePath = parsed.filePath;
  logger.info({ filePath }, 'Validating file in PR');
  
  // Step 2: Validate file is in PR changed files
  const validation = validateFileInPr(filePath, changedFiles);
  if (!validation.valid) {
    await upsertComment(
      octokit, owner, repo, issueNumber,
      `**Error:** ${validation.error}`,
      REVIEW_MARKER,
      { replyToId: commentId, updateExisting: false }
    );
    // Add error reaction if commentId available
    if (commentId) {
      await setReaction(octokit, owner, repo, commentId, REACTIONS.X);
    }
    return { success: false, error: validation.error };
  }
  
  const targetFile = validation.file;
  logger.info({ filePath, status: targetFile.status }, 'File validated, building prompt');
  
  // Step 3: Build targeted prompt
  const { prompt, truncated } = buildReviewPrompt(targetFile);
  
  // Step 4: Call Z.ai API
  try {
    logger.info({ filePath }, 'Calling Z.ai API for review');
    
    const result = await apiClient.call({
      apiKey,
      model,
      prompt
    });
    
    if (!result.success) {
      const errorMsg = result.error?.message || 'Failed to get review';
      logger.error({ error: errorMsg }, 'API call failed');
      await upsertComment(
        octokit, owner, repo, issueNumber,
        `**Error:** ${errorMsg}`,
        REVIEW_MARKER,
        { replyToId: commentId, updateExisting: false }
      );
      // Add error reaction if commentId available
      if (commentId) {
        await setReaction(octokit, owner, repo, commentId, REACTIONS.X);
      }
      return { success: false, error: errorMsg };
    }
    
    let response = result.data;
    
    // Add truncation note if needed
    if (truncated) {
      response += '\n\n_(Note: Context was truncated due to size limits)_';
    }
    
    // Format the response with header
    const formattedResponse = `## 📝 Code Review: ${targetFile.filename}\n\n${response}`;
    
    // Step 5: Post comment
    await upsertComment(
      octokit, owner, repo, issueNumber,
      formattedResponse,
      REVIEW_MARKER,
      { replyToId: commentId, updateExisting: false }
    );
    
    // Add success reaction if commentId available
    if (commentId) {
      await setReaction(octokit, owner, repo, commentId, REACTIONS.ROCKET);
    }
    
    logger.info({ filePath }, 'Review posted successfully');
    return { success: true };
    
  } catch (error) {
    logger.error({ error: error.message }, 'Review command failed');
    
    await upsertComment(
      octokit, owner, repo, issueNumber,
      `**Error:** Failed to complete review. Please try again later.`,
      REVIEW_MARKER,
      { replyToId: commentId, updateExisting: false }
    );
    
    // Add error reaction if commentId available
    if (commentId) {
      await setReaction(octokit, owner, repo, commentId, REACTIONS.X);
    }
    
    return { success: false, error: error.message };
  }
}

module.exports = {
  handleReviewCommand,
  parseFilePath,
  validateFileInPr,
  buildReviewPrompt,
  REVIEW_MARKER,
};
