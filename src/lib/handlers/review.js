/**
 * Review command handler for /zai review
 * 
 * Validates file is in PR changed files and builds targeted review prompt.
 */

const { truncateContext, DEFAULT_MAX_CHARS } = require('../context');
const { fetchFileAtPrHead } = require('../pr-context');
const { REACTIONS, upsertComment, setReaction } = require('../comments');
const { createLogger, generateCorrelationId } = require('../logging');

const REVIEW_MARKER = '<!-- ZAI_REVIEW_COMMAND -->';

function parseFilePath(args) {
  if (!args || args.length === 0) {
    return { filePath: null, error: 'No file path provided. Usage: /zai review <filepath>' };
  }
  
  const filePath = args.join('/');
  
  if (filePath.includes('..') || filePath.startsWith('/')) {
    return { filePath: null, error: 'Invalid file path. Path traversal is not allowed.' };
  }
  
  return { filePath };
}

function validateFileInPr(filePath, changedFiles) {
  if (!changedFiles || !Array.isArray(changedFiles)) {
    return { valid: false, error: 'Unable to get PR changed files list' };
  }
  
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

function buildReviewPrompt(filePath, fullContent, patch, maxChars = DEFAULT_MAX_CHARS) {
  let content = `You are a Senior Code Reviewer.\nContext:\n<file_path>${filePath}</file_path>\n`;

  if (fullContent) {
    const truncatedFullCode = truncateContext(fullContent, Math.floor(maxChars * 0.6));
    content += `<full_code>\n${truncatedFullCode.content}\n</full_code>\n`;
  } else {
    content += `<full_code>\n[Full file content unavailable: file not found, binary, or too large]\n</full_code>\n`;
  }

  if (patch) {
    const truncatedPatch = truncateContext(patch, Math.floor(maxChars * 0.35));
    content += `<changes_in_this_pr>\n${truncatedPatch.content}\n</changes_in_this_pr>\n`;
  } else {
    content += `<changes_in_this_pr>\n[No diff available - file may be binary, too large, or unchanged]\n</changes_in_this_pr>\n`;
  }

  content += `\nTask: Review the changes in the context of the whole file. Look for logic errors, security vulnerabilities, and architectural mismatches. Focus on how the new changes interact with existing code.`;

  const truncated = truncateContext(content, maxChars);
  return { prompt: truncated.content, truncated: truncated.truncated };
}

async function handleReviewCommand(context, args, deps = {}) {
  const {
    upsertComment: _upsertComment = upsertComment,
    setReaction: _setReaction = setReaction,
    fetchFileAtPrHead: _fetchFileAtPrHead = fetchFileAtPrHead,
    createLogger: _createLogger = createLogger,
    generateCorrelationId: _generateCorrelationId = generateCorrelationId,
  } = deps;
  
  const { octokit, owner, repo, issueNumber, changedFiles, apiClient, apiKey, model, commentId } = context;
  const logger = context.logger || _createLogger(_generateCorrelationId(), { command: 'review' });
  const commentOptions = {
    replyToId: commentId,
    updateExisting: false,
    isReviewComment: Boolean(context.isReviewComment),
    pullNumber: context.pullNumber || issueNumber,
  };
  
  const parsed = parseFilePath(args);
  if (parsed.error) {
    await _upsertComment(
      octokit, owner, repo, issueNumber,
      `**Error:** ${parsed.error}`,
      REVIEW_MARKER,
      commentOptions
    );
    if (commentId) {
      await _setReaction(octokit, owner, repo, commentId, REACTIONS.X);
    }
    return { success: false, error: parsed.error };
  }
  
  const filePath = parsed.filePath;
  logger.info({ filePath }, 'Validating file in PR');
  
  const validation = validateFileInPr(filePath, changedFiles);
  if (!validation.valid) {
    await _upsertComment(
      octokit, owner, repo, issueNumber,
      `**Error:** ${validation.error}`,
      REVIEW_MARKER,
      commentOptions
    );
    if (commentId) {
      await _setReaction(octokit, owner, repo, commentId, REACTIONS.X);
    }
    return { success: false, error: validation.error };
  }
  
  const targetFile = validation.file;
  const patch = targetFile.patch || null;
  logger.info({ filePath, status: targetFile.status }, 'File validated, fetching full content at PR head');

  const pullNumber = context.pullNumber || context.issueNumber;
  const fullContentResult = await _fetchFileAtPrHead(
    context.octokit,
    context.owner,
    context.repo,
    filePath,
    pullNumber,
    {
      maxFileSize: DEFAULT_MAX_CHARS,
      maxFileLines: 10000,
      patch,
      patchSide: 'new',
    }
  );

  const fullContent = fullContentResult.success ? fullContentResult.data : null;

  const maxChars = context.maxChars || DEFAULT_MAX_CHARS;
  const { prompt, truncated } = buildReviewPrompt(filePath, fullContent, patch, maxChars);
  
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
      await _upsertComment(
        octokit, owner, repo, issueNumber,
        `**Error:** ${errorMsg}`,
        REVIEW_MARKER,
        commentOptions
      );
      if (commentId) {
        await _setReaction(octokit, owner, repo, commentId, REACTIONS.X);
      }
      return { success: false, error: errorMsg };
    }
    
    let response = result.data;
    
    if (truncated) {
      response += '\n\n_(Note: Context was truncated due to size limits)_';
    }
    
    const formattedResponse = `## 📝 Code Review: ${targetFile.filename}\n\n${response}`;
    
    await _upsertComment(
      octokit, owner, repo, issueNumber,
      formattedResponse,
      REVIEW_MARKER,
      commentOptions
    );
    
    if (commentId) {
      await _setReaction(octokit, owner, repo, commentId, REACTIONS.ROCKET);
    }
    
    logger.info({ filePath }, 'Review posted successfully');
    return { success: true };
    
  } catch (error) {
    logger.error({ error: error.message }, 'Review command failed');
    
    await _upsertComment(
      octokit, owner, repo, issueNumber,
      `**Error:** Failed to complete review. Please try again later.`,
      REVIEW_MARKER,
      commentOptions
    );
    
    if (commentId) {
      await _setReaction(octokit, owner, repo, commentId, REACTIONS.X);
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
