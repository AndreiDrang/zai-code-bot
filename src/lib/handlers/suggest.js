/**
 * Suggest Command Handler
 * 
 * Handles `/zai suggest <prompt>` command for prompt-guided improvements.
 * Uses user's suggestion prompt to guide analysis of code changes.
 */

const { truncateContext, DEFAULT_MAX_CHARS } = require('../context');
const { createApiClient } = require('../api');
const { createLogger, generateCorrelationId, getUserMessage } = require('../logging');
const { REACTIONS, setReaction } = require('../comments');

/**
 * Builds a suggestion prompt combining diff with user's guidance
 * @param {Array} files - Array of changed files with patches
 * @param {string} userPrompt - User's suggestion prompt
 * @returns {string} Formatted prompt for the API
 */
function buildSuggestPrompt(files, userPrompt) {
  const diffs = files
    .filter(f => f.patch)
    .map(f => `### ${f.filename} (${f.status})\n\`\`\`diff\n${f.patch}\n\`\`\``)
    .join('\n\n');

  return `You are an expert code reviewer. Based on the following code changes, ${userPrompt}\n\nProvide specific, actionable suggestions with code examples where appropriate.\n\n## Changed Files:\n\n${diffs}`;
}

/**
 * Formats suggestions response with markdown code blocks
 * @param {string} suggestions - Raw suggestions from API
 * @returns {string} Formatted response with code blocks
 */
function formatSuggestionsResponse(suggestions) {
  // Ensure suggestions are wrapped in code blocks for proper formatting
  if (!suggestions.includes('```')) {
    return `## Suggested Improvements\n\n${suggestions}`;
  }
  return `## Suggested Improvements\n\n${suggestions}`;
}

/**
 * Handles the /zai suggest command
 * @param {Object} context - Handler context object
 * @param {Object} context.octokit - GitHub Octokit instance
 * @param {Object} context.context - GitHub context object
 * @param {Object} context.payload - Event payload with pull request
 * @param {string} context.apiKey - Z.ai API key
 * @param {string} context.model - Z.ai model to use
 * @param {string} context.userPrompt - User's suggestion prompt (remaining args after 'suggest')
 * @returns {Promise<{success: boolean, response?: string, error?: string}>}
 */
async function handleSuggestCommand(context) {
  const { octokit, context: githubContext, payload, apiKey, model, userPrompt, commentId } = context;
  const { owner, repo } = githubContext.repo;

  // Generate correlation ID for tracking
  const correlationId = generateCorrelationId();
  const logger = createLogger(correlationId, {
    eventName: githubContext.eventName,
    prNumber: payload.pull_request?.number,
    command: 'suggest',
  });

  logger.info({ userPrompt }, 'Processing suggest command');

  // Validate user prompt
  if (!userPrompt || userPrompt.trim().length === 0) {
    // Add error reaction if commentId available
    if (commentId) {
      await setReaction(octokit, owner, repo, commentId, REACTIONS.X);
    }
    return {
      success: false,
      error: 'Please provide a suggestion prompt. Usage: /zai suggest <your suggestion>',
    };
  }

  try {
    // Fetch changed files from the PR
    const pullNumber = payload.pull_request.number;

    logger.info({ pullNumber }, 'Fetching changed files');

    const { data: files } = await octokit.rest.pulls.listFiles({
      owner,
      repo,
      pull_number: pullNumber,
      per_page: 100,
    });

    if (!files || files.length === 0) {
      // Add error reaction if commentId available
      if (commentId) {
        await setReaction(octokit, owner, repo, commentId, REACTIONS.X);
      }
      return {
        success: false,
        error: 'No changed files found in this pull request.',
      };
    }

    // Check if any files have patches
    const filesWithPatches = files.filter(f => f.patch);
    if (filesWithPatches.length === 0) {
      // Add error reaction if commentId available
      if (commentId) {
        await setReaction(octokit, owner, repo, commentId, REACTIONS.X);
      }
      return {
        success: false,
        error: 'No patchable changes found in this pull request.',
      };
    }

    // Build the suggestion prompt
    const prompt = buildSuggestPrompt(files, userPrompt);

    // Apply context budget truncation
    const truncated = truncateContext(prompt, DEFAULT_MAX_CHARS);
    if (truncated.truncated) {
      logger.info({ originalLength: prompt.length, truncatedLength: truncated.content.length },
        'Context truncated due to size');
    }

    // Call the Z.ai API
    logger.info({ promptLength: truncated.content.length }, 'Calling Z.ai API');

    const apiClient = createApiClient({ timeout: 30000, maxRetries: 3 });
    const result = await apiClient.call({
      apiKey,
      model,
      prompt: truncated.content,
    });

    if (!result.success) {
      const category = result.error.category || 'provider';
      const userMessage = getUserMessage(category, new Error(result.error.message));
      
      logger.error({ error: result.error }, 'API call failed');
      
      // Add error reaction if commentId available
      if (commentId) {
        await setReaction(octokit, owner, repo, commentId, REACTIONS.X);
      }
      
      return {
        success: false,
        error: userMessage,
      };
    }

    // Format the response with markdown code blocks
    const response = formatSuggestionsResponse(result.data);

    logger.info({ responseLength: response.length }, 'Suggest command completed successfully');

    // Add success reaction if commentId available
    if (commentId) {
      await setReaction(octokit, owner, repo, commentId, REACTIONS.ROCKET);
    }

    return {
      success: true,
      response,
    };

  } catch (error) {
    logger.error({ error: error.message }, 'Unexpected error in suggest command');
    
    const category = 'internal';
    const userMessage = getUserMessage(category, error);
    
    // Add error reaction if commentId available
    if (commentId) {
      await setReaction(octokit, owner, repo, commentId, REACTIONS.X);
    }
    
    return {
      success: false,
      error: userMessage,
    };
  }
}

module.exports = {
  handleSuggestCommand,
  buildSuggestPrompt,
  formatSuggestionsResponse,
};
