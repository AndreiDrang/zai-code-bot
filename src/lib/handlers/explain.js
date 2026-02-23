/**
 * Explain command handler for /zai explain <lines>
 * 
 * Parses line range, validates with context.validateRange, extracts lines,
 * and requests explanation from Z.ai API.
 */

const { extractLines, validateRange, truncateContext, DEFAULT_MAX_CHARS } = require('../context');
const { upsertComment } = require('../comments');
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
 * Build explanation prompt with extracted lines
 * @param {string} filename - File being explained
 * @param {string[]} lines - Extracted lines
 * @param {number} startLine - Start line number
 * @param {number} endLine - End line number
 * @param {number} maxChars - Maximum prompt characters
 * @returns {{ prompt: string, truncated: boolean }}
 */
function buildExplainPrompt(filename, lines, startLine, endLine, maxChars = DEFAULT_MAX_CHARS) {
  const codeContent = lines.join('\n');
  
  let prompt = `Please explain the following code from file: ${filename}\n`;
  prompt += `Lines ${startLine}-${endLine}:\n\n`;
  prompt += `\`\`\`\n${codeContent}\n\`\`\``;
  
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
 * @param {string} context.fileContent - File content to explain
 * @param {string} context.filename - File name
 * @param {Object} context.apiClient - Z.ai API client
 * @param {string} context.apiKey - Z.ai API key
 * @param {string} context.model - Z.ai model to use
 * @param {Object} context.logger - Logger instance
 * @param {string[]} args - Command arguments (line range)
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function handleExplainCommand(context, args) {
  const { octokit, owner, repo, issueNumber, fileContent, filename, apiClient, apiKey, model } = context;
  const logger = context.logger || createLogger(generateCorrelationId(), { command: 'explain' });

  if (!args || args.length === 0) {
    await upsertComment(
      octokit, owner, repo, issueNumber,
      `**Error:** No line range provided. Usage: /zai explain 10-15`,
      EXPLAIN_MARKER
    );
    return { success: false, error: 'No line range provided' };
  }

  // Step 1: Parse line range
  const parsed = parseLineRange(args[0]);
  if (parsed.error) {
    await upsertComment(
      octokit, owner, repo, issueNumber,
      `**Error:** ${parsed.error}`,
      EXPLAIN_MARKER
    );
    return { success: false, error: parsed.error };
  }

  const { startLine, endLine } = parsed;
  logger.info({ startLine, endLine, filename }, 'Parsed line range');

  // Step 2: Validate line range bounds
  const lines = fileContent.split('\n');
  const maxLines = lines.length;
  
  const validation = validateRange(startLine, endLine, maxLines);
  if (!validation.valid) {
    await upsertComment(
      octokit, owner, repo, issueNumber,
      `**Error:** ${validation.error}. File has ${maxLines} lines.`,
      EXPLAIN_MARKER
    );
    return { success: false, error: validation.error };
  }

  // Step 3: Extract lines
  const extracted = extractLines(fileContent, startLine, endLine);
  if (!extracted.valid) {
    await upsertComment(
      octokit, owner, repo, issueNumber,
      `**Error:** ${extracted.error}`,
      EXPLAIN_MARKER
    );
    return { success: false, error: extracted.error };
  }

  logger.info({ linesExtracted: extracted.lines.length }, 'Lines extracted');

  // Step 4: Build prompt
  const { prompt, truncated } = buildExplainPrompt(filename, extracted.lines, startLine, endLine);

  // Step 5: Call Z.ai API
  try {
    logger.info({ filename, startLine, endLine }, 'Calling Z.ai API for explanation');

    const result = await apiClient.call({
      apiKey,
      model,
      prompt
    });

    if (!result.success) {
      const errorMsg = result.error?.message || 'Failed to get explanation';
      logger.error({ error: errorMsg }, 'API call failed');
      await upsertComment(
        octokit, owner, repo, issueNumber,
        `**Error:** ${errorMsg}`,
        EXPLAIN_MARKER
      );
      return { success: false, error: errorMsg };
    }

    let response = result.data;

    if (truncated) {
      response += '\n\n_(Note: Context was truncated due to size limits)_';
    }

    const formattedResponse = `## 📖 Explanation: ${filename}:${startLine}-${endLine}\n\n${response}`;

    await upsertComment(
      octokit, owner, repo, issueNumber,
      formattedResponse,
      EXPLAIN_MARKER
    );

    logger.info({ filename, startLine, endLine }, 'Explanation posted successfully');
    return { success: true };

  } catch (error) {
    logger.error({ error: error.message }, 'Explain command failed');

    await upsertComment(
      octokit, owner, repo, issueNumber,
      `**Error:** Failed to complete explanation. Please try again later.`,
      EXPLAIN_MARKER
    );

    return { success: false, error: error.message };
  }
}

module.exports = {
  handleExplainCommand,
  parseLineRange,
  buildExplainPrompt,
  EXPLAIN_MARKER,
};
