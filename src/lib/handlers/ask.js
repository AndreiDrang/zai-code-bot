/**
 * Ask Command Handler
 * 
 * Handles `/zai ask <question>` command.
 * Answers questions about the codebase using Z.ai API.
 */

const auth = require('../auth');
const api = require('../api');
const comments = require('../comments');
const context = require('../context');
const logging = require('../logging');
const continuity = require('../continuity');

const { REACTIONS, setReaction } = require('../comments');

/**
 * Validates the ask command arguments
 * @param {string[]} args - Command arguments
 * @returns {{ valid: boolean, error?: string }}
 */
function validateArgs(args) {
  if (!args || args.length === 0) {
    return {
      valid: false,
      error: 'Please provide a question. Usage: /zai ask <question>'
    };
  }

  const question = args.join(' ').trim();
  if (!question) {
    return {
      valid: false,
      error: 'Please provide a question. Usage: /zai ask <question>'
    };
  }

  return { valid: true };
}

/**
 * Handle the ask command
 * @param {Object} params - Handler parameters
 * @param {Object} params.octokit - GitHub Octokit instance
 * @param {Object} params.context - GitHub context object
 * @param {Object} params.commenter - Commenter object with login property
 * @param {string[]} params.args - Command arguments (the question)
 * @param {Object} params.config - Configuration object with apiKey and model
 * @param {Object} params.logger - Logger instance
 * @returns {Promise<{ success: boolean, message?: string, error?: string }>}
 */
async function handleAskCommand({ octokit, context: githubContext, commenter, args, continuityState = null, config, logger }) {
  // Validate arguments
  const validation = validateArgs(args);
  if (!validation.valid) {
    return { success: false, error: validation.error };
  }

  // Check authorization
  const authResult = await auth.checkForkAuthorization(octokit, githubContext, commenter);
  if (!authResult.authorized) {
    // Silent block for fork PRs, otherwise return error message
    if (authResult.reason) {
      return { success: false, error: authResult.reason };
    }
    // Silent block - don't respond
    return { success: false, error: null };
  }

  const question = args.join(' ').trim();
  const { owner, repo } = githubContext.repo;
  const issueNumber = githubContext.payload.pull_request.number;

  // Get the comment ID for threading
  const commentId = githubContext.payload.comment?.id;

  // Build context with file information if available
  const contextContent = await buildContext(githubContext);
  const truncatedContext = context.truncateContext(contextContent, context.DEFAULT_MAX_CHARS);

  // Build the prompt
  const prompt = buildPrompt(question, truncatedContext.content);

  // Add reaction to show we're processing (acknowledgment)
  if (commentId) {
    await setReaction(octokit, owner, repo, commentId, REACTIONS.THINKING);
  }

  // Call the API
  const apiClient = api.createApiClient({ timeout: config.timeout, maxRetries: config.maxRetries });
  const result = await apiClient.call({
    apiKey: config.apiKey,
    model: config.model,
    prompt
  });

  if (!result.success) {
    logger.error(
      { command: 'ask', errorCategory: result.error.category },
      `API call failed: ${result.error.message}`
    );
    const userMessage = logging.getUserMessage(result.error.category, new Error(result.error.message));
    
    // Add error reaction
    if (commentId) {
      await setReaction(octokit, owner, repo, commentId, REACTIONS.X);
    }
    
    return { success: false, error: userMessage };
  }

  // Post the response as a threaded reply
  const responseBody = formatResponse(result.data, question);
  const nextState = continuity.mergeState(continuityState, {
    lastCommand: 'ask',
    lastArgs: question,
    lastUser: commenter?.login || 'unknown',
    turnCount: (continuityState?.turnCount || 0) + 1,
    updatedAt: new Date().toISOString(),
  });
  const responseWithState = continuity.createCommentWithState(responseBody, nextState);
  
  const marker = '<!-- ZAI-ASK-RESPONSE -->';
  const commentResult = await comments.upsertComment(
    octokit,
    owner,
    repo,
    issueNumber,
    responseWithState + '\n\n' + marker,
    marker,
    { replyToId: commentId, updateExisting: false }
  );

  if (commentResult.action === 'created' || commentResult.action === 'updated') {
    // Add success reaction
    if (commentId) {
      await setReaction(octokit, owner, repo, commentId, REACTIONS.ROCKET);
    }
    
    logger.info({ command: 'ask', question: question.substring(0, 50) }, 'Ask command completed successfully');
    return { success: true };
  }

  // Add error reaction for failed comment post
  if (commentId) {
    await setReaction(octokit, owner, repo, commentId, REACTIONS.X);
  }
  
  return { success: false, error: 'Failed to post response' };
}

/**
 * Build context from PR changes
 * @param {Object} githubContext - GitHub context
 * @returns {Promise<string>} Context string
 */
async function buildContext(githubContext) {
  // For ask command, we'll include recent file changes as context
  // This is a simplified version - full implementation would fetch relevant files
  const pullRequest = githubContext.payload.pull_request;
  const title = pullRequest?.title || '';
  const body = pullRequest?.body || '';
  
  return `Pull Request: ${title}\n\nDescription: ${body}\n\n---\nYou are being asked a question about this pull request.`;
}

/**
 * Build prompt for the API
 * @param {string} question - User's question
 * @param {string} contextContent - Context from PR
 * @returns {string} Full prompt
 */
function buildPrompt(question, contextContent) {
  return `${contextContent}\n\n---\n\nQuestion: ${question}\n\nPlease answer this question about the code changes above.`;
}

/**
 * Format the API response
 * @param {string} data - Raw API response
 * @param {string} question - Original question
 * @returns {string} Formatted response
 */
function formatResponse(data, question) {
  return `## Answer to: "${question}"\n\n${data}\n\n---\n*Response from Z.ai*`;
}

module.exports = {
  handleAskCommand,
  validateArgs,
  buildContext,
  buildPrompt,
  formatResponse,
};
