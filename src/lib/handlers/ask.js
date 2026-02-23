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

const MAX_TRANSCRIPT_COMMENTS = 20;
const MAX_COMMENT_BODY_CHARS = 1200;
const MAX_FILE_CONTEXT_CHARS = 10000;
const SMALL_DIFF_THRESHOLD_CHARS = 12000;
const MAX_DIFF_FILES = 8;
const MAX_RAW_FILE_CHARS = 4000;

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

  const contextualData = await buildContext({
    octokit,
    githubContext,
    logger,
    maxChars: context.DEFAULT_MAX_CHARS,
  });

  // Build the prompt
  const prompt = buildPrompt(question, contextualData);

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
    `${responseWithState}\n\n${marker}`,
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

async function buildContext({ octokit, githubContext, logger, maxChars = context.DEFAULT_MAX_CHARS }) {
  const pullRequest = githubContext.payload.pull_request || {};
  const prContext = [
    `PR #${pullRequest.number || githubContext.payload.issue?.number || 'unknown'}`,
    `Title: ${pullRequest.title || githubContext.payload.issue?.title || ''}`,
    `Description: ${pullRequest.body || githubContext.payload.issue?.body || ''}`,
  ].join('\n');

  const conversationHistory = await getThreadTranscript(octokit, githubContext, {
    logger,
    limit: MAX_TRANSCRIPT_COMMENTS,
  });

  const fileContext = await getRelevantFileContent(octokit, githubContext, {
    logger,
    maxChars: MAX_FILE_CONTEXT_CHARS,
    smallDiffThresholdChars: SMALL_DIFF_THRESHOLD_CHARS,
    maxDiffFiles: MAX_DIFF_FILES,
    maxRawFileChars: MAX_RAW_FILE_CHARS,
  });

  return {
    prContext: context.truncateContext(prContext, Math.max(200, Math.floor(maxChars * 0.2))).content,
    conversationHistory: context.truncateContext(conversationHistory, Math.max(800, Math.floor(maxChars * 0.35))).content,
    fileContext: context.truncateContext(fileContext, Math.max(1200, Math.floor(maxChars * 0.45))).content,
  };
}

async function getThreadTranscript(octokit, githubContext, options = {}) {
  const logger = options.logger;
  const limit = options.limit || MAX_TRANSCRIPT_COMMENTS;
  const { owner, repo } = githubContext.repo;
  const issueNumber = githubContext.payload.issue?.number || githubContext.payload.pull_request?.number;

  if (!issueNumber) {
    return 'No conversation history available.';
  }

  try {
    const { data: commentsData } = await octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number: issueNumber,
      per_page: 100,
    });

    if (!Array.isArray(commentsData) || commentsData.length === 0) {
      return 'No previous conversation found for this PR.';
    }

    const transcript = commentsData
      .slice()
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
      .slice(-limit)
      .map((comment) => formatTranscriptComment(comment))
      .join('\n\n');

    return transcript || 'No previous conversation found for this PR.';
  } catch (error) {
    if (logger) {
      logger.warn(
        { command: 'ask', status: error?.status, operation: 'issues.listComments' },
        `Failed to fetch PR comments: ${error.message}`
      );
    }

    if (isRateLimitError(error)) {
      return 'Conversation history is temporarily unavailable due to GitHub API rate limits.';
    }

    return 'Conversation history is currently unavailable.';
  }
}

function formatTranscriptComment(comment) {
  const login = comment?.user?.login || 'unknown';
  const role = isBotComment(comment) ? 'Bot' : 'User';
  const createdAt = comment?.created_at || 'unknown-time';
  const body = normalizeCommentBody(comment?.body || '');
  return `[${createdAt}] ${role} (${login}):\n${body}`;
}

function normalizeCommentBody(body) {
  const compact = String(body).replace(/\r\n/g, '\n').trim();
  if (!compact) {
    return '[empty comment]';
  }
  if (compact.length <= MAX_COMMENT_BODY_CHARS) {
    return compact;
  }
  return `${compact.slice(0, MAX_COMMENT_BODY_CHARS)}...[truncated]`;
}

function isBotComment(comment) {
  const login = (comment?.user?.login || '').toLowerCase();
  if (comment?.user?.type === 'Bot') {
    return true;
  }
  return login.endsWith('[bot]') || login.includes('zai-code-bot');
}

async function getRelevantFileContent(octokit, githubContext, options = {}) {
  const logger = options.logger;
  const maxChars = options.maxChars || MAX_FILE_CONTEXT_CHARS;
  const smallDiffThresholdChars = options.smallDiffThresholdChars || SMALL_DIFF_THRESHOLD_CHARS;
  const maxDiffFiles = options.maxDiffFiles || MAX_DIFF_FILES;
  const maxRawFileChars = options.maxRawFileChars || MAX_RAW_FILE_CHARS;

  const { owner, repo } = githubContext.repo;
  const pullNumber = githubContext.payload.pull_request?.number || githubContext.payload.issue?.number;
  const commentPath = githubContext.payload.comment?.path || null;
  const commentDiffHunk = githubContext.payload.comment?.diff_hunk || '';

  if (!pullNumber) {
    return 'No PR file context available.';
  }

  let files;
  try {
    const { data } = await octokit.rest.pulls.listFiles({
      owner,
      repo,
      pull_number: pullNumber,
      per_page: 100,
    });
    files = Array.isArray(data) ? data : [];
  } catch (error) {
    if (logger) {
      logger.warn(
        { command: 'ask', status: error?.status, operation: 'pulls.listFiles' },
        `Failed to fetch PR files: ${error.message}`
      );
    }
    if (isRateLimitError(error)) {
      return 'File context is temporarily unavailable due to GitHub API rate limits.';
    }
    return 'File context is currently unavailable.';
  }

  if (files.length === 0) {
    return 'No changed files were found in this pull request.';
  }

  const totalPatchChars = files.reduce((sum, file) => sum + (file.patch ? file.patch.length : 0), 0);
  const includeAllDiffs = files.length <= maxDiffFiles && totalPatchChars <= smallDiffThresholdChars;

  const sections = [];

  if (commentPath) {
    const matchedFile = files.find((file) => file.filename === commentPath);
    if (matchedFile) {
      sections.push(
        [
          `Focused file from thread: ${matchedFile.filename}`,
          `Status: ${matchedFile.status}`,
          '',
          'Diff:',
          matchedFile.patch || '[No diff patch available for this file]',
        ].join('\n')
      );
    } else {
      sections.push(`Thread references file path \`${commentPath}\`, but it was not found in changed files.`);
    }

    if (commentDiffHunk) {
      sections.push(`Referenced diff hunk:\n${commentDiffHunk}`);
    }

    const rawFile = await getRawFileAtHead(octokit, githubContext, commentPath, maxRawFileChars, logger);
    if (rawFile) {
      sections.push(`Raw file snapshot for ${commentPath}:\n${rawFile}`);
    }
  }

  const targetFiles = includeAllDiffs ? files : files.slice(0, maxDiffFiles);
  const diffHeader = includeAllDiffs
    ? 'PR diff context (all changed files):'
    : `PR diff context (first ${targetFiles.length} of ${files.length} files):`;
  sections.push(diffHeader);

  for (const file of targetFiles) {
    sections.push(
      [
        `File: ${file.filename}`,
        `Status: ${file.status}`,
        file.patch ? `Patch:\n${file.patch}` : 'Patch: [No patch available; file may be binary or too large]',
      ].join('\n')
    );
  }

  const combined = sections.join('\n\n---\n\n');
  return context.truncateContext(combined, maxChars).content;
}

async function getRawFileAtHead(octokit, githubContext, filePath, maxChars, logger) {
  if (!filePath) {
    return null;
  }

  const { owner, repo } = githubContext.repo;
  const pullNumber = githubContext.payload.pull_request?.number || githubContext.payload.issue?.number;

  try {
    const headSha = await resolveHeadSha(octokit, githubContext, pullNumber);
    if (!headSha) {
      return null;
    }

    const { data } = await octokit.rest.repos.getContent({
      owner,
      repo,
      path: filePath,
      ref: headSha,
    });

    if (!data || Array.isArray(data) || !data.content) {
      return null;
    }

    const decoded = Buffer.from(data.content, 'base64').toString('utf8');
    return context.truncateContext(decoded, maxChars).content;
  } catch (error) {
    if (logger) {
      logger.warn(
        { command: 'ask', status: error?.status, operation: 'repos.getContent', filePath },
        `Failed to fetch raw file content: ${error.message}`
      );
    }

    if (error?.status === 404) {
      return `[Raw file content unavailable: ${filePath} not found at PR head]`;
    }
    if (isRateLimitError(error)) {
      return '[Raw file content unavailable due to GitHub API rate limits]';
    }
    return '[Raw file content unavailable]';
  }
}

async function resolveHeadSha(octokit, githubContext, pullNumber) {
  const directSha = githubContext.payload.pull_request?.head?.sha;
  if (directSha) {
    return directSha;
  }
  if (!pullNumber) {
    return null;
  }

  const { owner, repo } = githubContext.repo;
  const { data } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: pullNumber,
  });
  return data?.head?.sha || null;
}

function isRateLimitError(error) {
  const message = (error?.message || '').toLowerCase();
  return error?.status === 429 || message.includes('rate limit') || message.includes('secondary rate limit');
}

/**
 * Build prompt for the API
 * @param {string} question - User's question
 * @param {string} contextContent - Context from PR
 * @returns {string} Full prompt
 */
function buildPrompt(question, contextContent) {
  if (typeof contextContent === 'string') {
    return `${contextContent}\n\n---\n\nQuestion: ${question}\n\nPlease answer this question about the code changes above.`;
  }

  const prContext = contextContent?.prContext || 'PR context unavailable.';
  const fileContext = contextContent?.fileContext || 'File context unavailable.';
  const conversationHistory = contextContent?.conversationHistory || 'Conversation history unavailable.';

  return [
    'You are Zai Code Bot, an expert pull request assistant.',
    'Answer using the available PR diff and conversation context. If context is missing, explicitly state assumptions.',
    `<pr_context>\n${prContext}\n</pr_context>`,
    `<file_context>\n${fileContext}\n</file_context>`,
    `<conversation_history>\n${conversationHistory}\n</conversation_history>`,
    `<user_query>\n${question}\n</user_query>`,
  ].join('\n\n');
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
  getThreadTranscript,
  getRelevantFileContent,
  buildPrompt,
  formatResponse,
};
