/**
 * Suggest Command Handler
 * 
 * Handles `/zai suggest <prompt>` command for prompt-guided improvements.
 * Uses user's suggestion prompt to guide analysis of specific code blocks.
 * Supports anchor resolution from comment metadata (review-comment) or instruction text.
 */

const { truncateContext, DEFAULT_MAX_CHARS } = require('../context');
const { createApiClient } = require('../api');
const { createLogger, generateCorrelationId, getUserMessage } = require('../logging');
const { REACTIONS, setReaction } = require('../comments');
const { fetchFileAtPrHead } = require('../pr-context');
const { extractEnclosingBlock } = require('../code-scope');

/**
 * Parse file:line pattern from instruction text
 * Supports formats: "path/to/file.js:42", "src/lib/auth.js:100"
 * @param {string} instruction - User instruction text
 * @returns {{path: string|null, line: number|null}}
 */
function parseFileLineAnchor(instruction) {
  if (!instruction || typeof instruction !== 'string') {
    return { path: null, line: null };
  }

  // Match file:line patterns - filename followed by colon and number
  const match = instruction.match(/([\w\-./\\]+):(\d+)/);
  
  if (!match) {
    return { path: null, line: null };
  }

  const path = match[1];
  const line = parseInt(match[2], 10);

  // Validate line number
  if (line < 1 || Number.isNaN(line)) {
    return { path: null, line: null };
  }

  return { path, line };
}

/**
 * Resolves anchor from context or instruction text
 * @param {Object} context - Handler context
 * @param {string} userInstruction - User's instruction text
 * @returns {{path: string|null, line: number|null, source: string}}
 */
function resolveAnchor(context, userInstruction) {
  // First: check commentPath/commentLine from context (review-comment event)
  const commentPath = context.commentPath || null;
  const commentLine = context.commentLine || null;

  if (commentPath && commentLine) {
    return {
      path: commentPath,
      line: commentLine,
      source: 'comment_metadata'
    };
  }

  // Second: try parsing file:line from instruction text
  const parsed = parseFileLineAnchor(userInstruction);
  if (parsed.path && parsed.line) {
    return {
      path: parsed.path,
      line: parsed.line,
      source: 'instruction_parse'
    };
  }

  // Third: no reliable anchor found
  return {
    path: null,
    line: null,
    source: 'none'
  };
}

/**
 * Builds a suggestion prompt combining code block with user's guidance
 * @param {string} path - File path being suggested on
 * @param {Object} blockResult - Result from extractEnclosingBlock
 * @param {string} userInstruction - User's suggestion prompt
 * @param {number} maxChars - Maximum characters for prompt
 * @returns {{prompt: string, truncated: boolean}}
 */
function buildSuggestPrompt(path, blockResult, userInstruction, maxChars = DEFAULT_MAX_CHARS) {
  const codeContent = blockResult.target.join('\n');
  const blockNote = blockResult.fallback 
    ? `\n\n_(Note: ${blockResult.note || 'Could not determine precise function/class block, using context window'})_`
    : '';

  let prompt = `You are an expert programmer. The user wants to improve or change a specific part of the code.\n`;
  prompt += `Current code context:\n`;
  prompt += `<file>${path}</file>\n`;
  prompt += `<code>\n${codeContent}\n</code>\n\n`;
  prompt += `User Instruction: ${userInstruction}${blockNote}\n\n`;
  prompt += `Task: Provide a code suggestion that fulfills the instruction. Output ONLY the code diff or the new code block in a format that can be easily applied.`;

  const truncated = truncateContext(prompt, maxChars);
  return { prompt: truncated.content, truncated: truncated.truncated };
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
 * @param {string} [context.commentPath] - File path from comment metadata (review-comment)
 * @param {number} [context.commentLine] - Line number from comment metadata
 * @returns {Promise<{success: boolean, response?: string, error?: string}>}
 */
async function handleSuggestCommand(context) {
  const { octokit, context: githubContext, payload, apiKey, model, userPrompt, commentId, commentPath, commentLine } = context;
  const { owner, repo } = githubContext.repo;

  // Generate correlation ID for tracking
  const correlationId = generateCorrelationId();
  const logger = createLogger(correlationId, {
    eventName: githubContext.eventName,
    prNumber: payload.pull_request?.number,
    command: 'suggest',
  });

  logger.info({ userPrompt, commentPath, commentLine }, 'Processing suggest command');

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

    // Resolve anchor: comment metadata -> instruction parse -> fallback
    const anchor = resolveAnchor({ commentPath, commentLine }, userPrompt);
    logger.info({ anchor }, 'Resolved anchor');

    let prompt = null;
    let truncated = false;

    if (anchor.path && anchor.line) {
      // Fetch file content at PR head for the anchor file
      const fileResult = await fetchFileAtPrHead(octokit, owner, repo, anchor.path, pullNumber, {
        maxFileSize: 200000,
        maxFileLines: 10000,
        anchorLine: anchor.line,
        preferEnclosingBlock: true,
      });
      
      if (fileResult.success && fileResult.data) {
        const fileContent = fileResult.data;
        
        // Extract surrounding function/class block around anchor line
        const blockResult = extractEnclosingBlock(fileContent, anchor.line);
        logger.info({ 
          blockLines: blockResult.target.length, 
          fallback: blockResult.fallback 
        }, 'Extracted enclosing block');

        // Build prompt with extracted block
        const promptResult = buildSuggestPrompt(anchor.path, blockResult, userPrompt);
        prompt = promptResult.prompt;
        truncated = promptResult.truncated;
      } else {
        // Failed to fetch anchor file, fall back to changed files
        logger.warn({ anchorPath: anchor.path, error: fileResult.error }, 'Failed to fetch anchor file, using fallback');
        anchor.source = 'fallback';
      }
    }

    // Fallback: use changed files when no anchor or fetch failed
    if (!prompt) {
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

      // Build fallback prompt using diffs
      const diffs = filesWithPatches
        .map(f => `### ${f.filename} (${f.status})\n\`\`\`diff\n${f.patch}\n\`\`\``)
        .join('\n\n');

      const fallbackNote = anchor.source === 'none' 
        ? '\n\n_(Note: No specific anchor detected. Providing suggestions based on all changed files.)_'
        : '';

      prompt = `You are an expert code reviewer. Based on the following code changes, ${userPrompt}${fallbackNote}\n\nProvide specific, actionable suggestions with code examples where appropriate.\n\n## Changed Files:\n\n${diffs}`;

      const truncatedResult = truncateContext(prompt, DEFAULT_MAX_CHARS);
      prompt = truncatedResult.content;
      truncated = truncatedResult.truncated;
    }

    // Apply context budget truncation (if not already truncated)
    if (!truncated) {
      const truncatedResult = truncateContext(prompt, DEFAULT_MAX_CHARS);
      prompt = truncatedResult.content;
      truncated = truncatedResult.truncated;
    }

    if (truncated) {
      logger.info({ promptLength: prompt.length }, 'Context truncated due to size');
    }

    // Call the Z.ai API
    logger.info({ promptLength: prompt.length }, 'Calling Z.ai API');

    const apiClient = createApiClient({ timeout: 30000, maxRetries: 3 });
    const result = await apiClient.call({
      apiKey,
      model,
      prompt: prompt,
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
  resolveAnchor,
  parseFileLineAnchor,
};
