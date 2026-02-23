const { truncateContext, DEFAULT_MAX_CHARS } = require('../context');
const { createApiClient } = require('../api');
const { createLogger, generateCorrelationId, getUserMessage } = require('../logging');

function buildComparePrompt(files) {
  const diffs = files
    .filter(f => f.patch)
    .map(f => `### ${f.filename} (${f.status})\n\`\`\`diff\n${f.patch}\n\`\`\``)
    .join('\n\n');

  return `You are an expert code reviewer. Compare the OLD version with the NEW version in the following pull request changes.

Analyze the differences and provide:
1. What changed between old and new versions
2. Key differences in approach or implementation
3. Potential implications of these changes
4. Any concerns or things to watch out for

## Changed Files:\n\n${diffs}`;
}

function formatCompareResponse(comparison) {
  if (!comparison.includes('```')) {
    return `## Old vs New Comparison\n\n${comparison}`;
  }
  return `## Old vs New Comparison\n\n${comparison}`;
}

async function handleCompareCommand(context) {
  const { octokit, context: githubContext, payload, apiKey, model } = context;

  const correlationId = generateCorrelationId();
  const logger = createLogger(correlationId, {
    eventName: githubContext.eventName,
    prNumber: payload.pull_request?.number,
    command: 'compare',
  });

  logger.info({}, 'Processing compare command');

  try {
    const { owner, repo } = githubContext.repo;
    const pullNumber = payload.pull_request.number;

    logger.info({ pullNumber }, 'Fetching changed files');

    const { data: files } = await octokit.rest.pulls.listFiles({
      owner,
      repo,
      pull_number: pullNumber,
      per_page: 100,
    });

    if (!files || files.length === 0) {
      return {
        success: false,
        error: 'No changed files found in this pull request.',
      };
    }

    const filesWithPatches = files.filter(f => f.patch);
    if (filesWithPatches.length === 0) {
      return {
        success: false,
        error: 'No patchable changes found in this pull request.',
      };
    }

    const prompt = buildComparePrompt(files);

    const truncated = truncateContext(prompt, DEFAULT_MAX_CHARS);
    if (truncated.truncated) {
      logger.info({ originalLength: prompt.length, truncatedLength: truncated.content.length },
        'Context truncated due to size');
    }

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
      
      return {
        success: false,
        error: userMessage,
      };
    }

    const response = formatCompareResponse(result.data);

    logger.info({ responseLength: response.length }, 'Compare command completed successfully');

    return {
      success: true,
      response,
    };

  } catch (error) {
    logger.error({ error: error.message }, 'Unexpected error in compare command');
    
    const category = 'internal';
    const userMessage = getUserMessage(category, error);
    
    return {
      success: false,
      error: userMessage,
    };
  }
}

module.exports = {
  handleCompareCommand,
  buildComparePrompt,
  formatCompareResponse,
};
