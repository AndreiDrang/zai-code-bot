const core = require('@actions/core');
const github = require('@actions/github');
const https = require('https');

const { getEventType, shouldProcessEvent, extractReviewCommentAnchor } = require('./lib/events.js');
const { parseCommand, isValid } = require('./lib/commands.js');
const { checkForkAuthorization, getUnauthorizedMessage, getCommenter } = require('./lib/auth.js');
const { handleAskCommand } = require('./lib/handlers/ask.js');
const { handleSuggestCommand } = require('./lib/handlers/suggest.js');
const { handleCompareCommand } = require('./lib/handlers/compare.js');
const { handleDescribeCommand } = require('./lib/handlers/describe');
const reviewHandler = require('./lib/handlers/review.js');
const explainHandler = require('./lib/handlers/explain.js');

const { truncateContext, DEFAULT_MAX_CHARS, fetchChangedFiles } = require('./lib/context.js');
const { loadContinuityState, mergeState, createCommentWithState } = require('./lib/continuity.js');
const { REACTIONS, setReaction, upsertComment } = require('./lib/comments.js');
const { createApiClient } = require('./lib/api.js');
const { createLogger, generateCorrelationId } = require('./lib/logging.js');
const ZAI_API_URL = 'https://api.z.ai/api/coding/paas/v4/chat/completions';
const COMMENT_MARKER = '<!-- zai-code-review -->';
const CONTINUITY_MARKER = '<!-- zai-continuity:';
const PROGRESS_MARKER = '<!-- zai-progress -->';
const GUIDANCE_MARKER = '<!-- zai-guidance -->';
const AUTH_MARKER = '<!-- zai-auth -->';

// Safe guidance messages for error cases
const GUIDANCE_MESSAGES = {
  unknown_command: `## Z.ai Help

Unknown command. Available commands:
- \`/zai ask <question>\` - Ask a question about the code
- \`/zai review\` - Request a full code review
- \`/zai explain <lines>\` - Explain specific lines
- \`/zai suggest\` - Get improvement suggestions
- \`/zai compare\` - Compare changes
- \`/zai describe\` - Generate PR description from commits
- \`/zai help\` - Show this help message
- \`/zai help\` - Show this help message

You can also use @zai-bot instead of /zai.

${COMMENT_MARKER}`,

  malformed_input: `## Z.ai Help

I couldn't understand that command. Commands should start with \`/zai\` or @zai-bot.

Examples:
- \`/zai ask what does this function do?\`
- \`/zai review\`
- \`/zai explain 10-20\`

${COMMENT_MARKER}`,

  empty_input: `## Z.ai Help

No command detected. Use \`/zai help\` to see available commands.

${COMMENT_MARKER}`,
};

async function getChangedFiles(octokit, owner, repo, pullNumber) {
  const { data: files } = await octokit.rest.pulls.listFiles({
    owner,
    repo,
    pull_number: pullNumber,
    per_page: 100,
  });
  return files;
}

function buildPrompt(files) {
  const diffs = files
    .filter(f => f.patch)
    .map(f => `### ${f.filename} (${f.status})\n\`\`\`diff\n${f.patch}\n\`\`\`\n`)
    .join('\n\n');

  return `Please review the following pull request changes and provide concise, constructive feedback. Focus on bugs, logic errors, security issues, and meaningful improvements. Skip trivial style comments.\n\n${diffs}`;
}

function callZaiApi(apiKey, model, prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model,
      messages: [
        {
          role: 'system',
          content: 'You are an expert code reviewer. Review the provided code changes and give clear, actionable feedback.',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
    });

    const url = new URL(ZAI_API_URL);
    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          const parsed = JSON.parse(data);
          const content = parsed.choices?.[0]?.message?.content;
          if (!content) {
            reject(new Error(`Z.ai API returned an empty response: ${data}`));
          } else {
            resolve(content);
          }
        } else {
          reject(new Error(`Z.ai API error ${res.statusCode}: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function enforceCommandAuthorization(context, octokit, owner, repo, options = {}) {
  const {
    issueNumber,
    pullNumber,
    replyToId,
    isReviewComment = false,
  } = options;

  const commenter = getCommenter(context);
  const authResult = await checkForkAuthorization(octokit, context, commenter);

  if (authResult.authorized) {
    return { authorized: true, commenter };
  }

  if (authResult.reason === null) {
    core.info(`Silently blocking command from non-collaborator on fork PR: ${commenter?.login || 'unknown'}`);
    return { authorized: false, commenter, silent: true };
  }

  const authMessage = getUnauthorizedMessage(authResult.reason);
  core.info(`Command authorization failed for ${commenter?.login || 'unknown'}: ${authResult.reason}`);

  await upsertComment(
    octokit,
    owner,
    repo,
    issueNumber,
    authMessage,
    AUTH_MARKER,
    { replyToId, updateExisting: false, isReviewComment, pullNumber }
  );

  if (replyToId) {
    try {
      await setReaction(octokit, owner, repo, replyToId, REACTIONS.X);
    } catch (error) {
      core.warning(`Failed to set auth-failure reaction: ${error.message}`);
    }
  }

  return { authorized: false, commenter, silent: false };
}

async function run() {
  const apiKey = core.getInput('ZAI_API_KEY', { required: true });
  const model = core.getInput('ZAI_MODEL') || 'glm-4.7';
  const zaiTimeout = parseInt(core.getInput('ZAI_TIMEOUT') || '30000', 10);

  const { context } = github;
  const { owner, repo } = context.repo;

  // Event routing and filtering
  const { process, reason } = shouldProcessEvent(context);
  if (!process) {
    core.info(`Skipping event: ${reason}`);
    return;
  }

  const eventType = getEventType(context);
  core.info(`Processing event type: ${eventType}`);

  // Route to appropriate handler
  if (eventType === 'pull_request') {
    await handlePullRequestEvent(context, apiKey, model, owner, repo);
  } else if (eventType === 'issue_comment_pr') {
    await handleIssueCommentEvent(context, apiKey, model, owner, repo, zaiTimeout);
  } else if (eventType === 'pull_request_review_comment') {
    await handlePullRequestReviewCommentEvent(context, apiKey, model, owner, repo, zaiTimeout);
  }
}

async function handlePullRequestEvent(context, apiKey, model, owner, repo) {
  const pullNumber = context.payload.pull_request?.number;

  if (!pullNumber) {
    core.setFailed('No pull request number found.');
    return;
  }

  const octokit = github.getOctokit(process.env.GITHUB_TOKEN || core.getInput('GITHUB_TOKEN'));

  core.info(`Fetching changed files for PR #${pullNumber}...`);
  const files = await getChangedFiles(octokit, owner, repo, pullNumber);

  if (!files.some(f => f.patch)) {
    core.info('No patchable changes found. Skipping review.');
    return;
  }

  const prompt = buildPrompt(files);

  core.info(`Sending ${files.length} file(s) to Z.ai for review...`);
  const review = await callZaiApi(apiKey, model, prompt);
  const body = `## Z.ai Code Review\n\n${review}\n\n${COMMENT_MARKER}`;

  const { data: comments } = await octokit.rest.issues.listComments({
    owner,
    repo,
    issue_number: pullNumber,
  });
  const existing = comments.find(c => c.body.includes(COMMENT_MARKER));

  if (existing) {
    await octokit.rest.issues.updateComment({
      owner,
      repo,
      comment_id: existing.id,
      body,
    });
    core.info('Review comment updated.');
  } else {
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: pullNumber,
      body,
    });
    core.info('Review comment posted.');
  }
}

async function handleIssueCommentEvent(context, apiKey, model, owner, repo, zaiTimeout) {
  const comment = context.payload.comment;
  const commentBody = comment?.body || '';
  const commentId = comment?.id;
  const pullNumber = context.payload.issue?.number;

  core.info(`Processing issue_comment on PR: ${commentBody.substring(0, 50)}...`);

  // Parse the command from comment body
  const parseResult = parseCommand(commentBody);

  // If parsing failed, post safe guidance message
  if (!isValid(parseResult)) {
    const errorType = parseResult.error.type;
    const guidance = GUIDANCE_MESSAGES[errorType] || GUIDANCE_MESSAGES.malformed_input;

    const octokit = github.getOctokit(process.env.GITHUB_TOKEN || core.getInput('GITHUB_TOKEN'));

    if (!pullNumber) {
      core.setFailed('No issue/PR number found.');
      return;
    }

    await upsertComment(
      octokit,
      owner,
      repo,
      pullNumber,
      guidance,
      GUIDANCE_MARKER,
      { replyToId: commentId, updateExisting: false, isReviewComment: false, pullNumber }
    );
    core.info(`Posted guidance comment for error: ${errorType}`);

    if (commentId) {
      try {
        await setReaction(octokit, owner, repo, commentId, REACTIONS.X);
      } catch (error) {
        core.warning(`Failed to set parse-failure reaction: ${error.message}`);
      }
    }
    return;
  }

  // Valid command - check authorization before dispatching
  core.info(`Valid command parsed: ${parseResult.command} with args: ${parseResult.args.join(' ')}`);

  const octokit = github.getOctokit(process.env.GITHUB_TOKEN || core.getInput('GITHUB_TOKEN'));
  const authState = await enforceCommandAuthorization(context, octokit, owner, repo, {
    issueNumber: pullNumber,
    pullNumber,
    replyToId: commentId,
    isReviewComment: false,
  });
  if (!authState.authorized) {
    return;
  }
  const { commenter } = authState;

  let continuityState = null;
  try {
    continuityState = await loadContinuityState(octokit, owner, repo, pullNumber);
  } catch (error) {
    core.warning(`Failed to load continuity state: ${error.message}`);
  }

  if (commentId && parseResult.command !== 'ask') {
    try {
      await setReaction(octokit, owner, repo, commentId, REACTIONS.EYES);
    } catch (error) {
      core.warning(`Failed to set acknowledgment reaction: ${error.message}`);
    }
  }

  await upsertComment(
    octokit,
    owner,
    repo,
    pullNumber,
    `🤖 Reviewing \`/zai ${parseResult.command}\`...\n\n${PROGRESS_MARKER}`,
    PROGRESS_MARKER,
    { replyToId: commentId, updateExisting: false, isReviewComment: false, pullNumber }
  );

  core.info(`Authorized command from collaborator: ${commenter.login}`);
  await dispatchCommand(context, parseResult, apiKey, model, owner, repo, zaiTimeout, {
    commentId,
    continuityState,
    commenter,
  });
}

async function handlePullRequestReviewCommentEvent(context, apiKey, model, owner, repo, zaiTimeout) {
  const comment = context.payload.comment;
  const commentBody = comment?.body || '';
  const commentId = comment?.id;
  
  // Get PR number from pull_request in the payload
  const pullNumber = context.payload.pull_request?.number;

  if (!pullNumber) {
    core.setFailed('No pull request number found in review comment event.');
    return;
  }

  core.info(`Processing pull_request_review_comment on PR #${pullNumber}: ${commentBody.substring(0, 50)}...`);

  // Parse the command from comment body
  const parseResult = parseCommand(commentBody);

  // If parsing failed, post safe guidance message
  if (!isValid(parseResult)) {
    const errorType = parseResult.error.type;
    const guidance = GUIDANCE_MESSAGES[errorType] || GUIDANCE_MESSAGES.malformed_input;

    const octokit = github.getOctokit(process.env.GITHUB_TOKEN || core.getInput('GITHUB_TOKEN'));

    await upsertComment(
      octokit,
      owner,
      repo,
      pullNumber,
      guidance,
      GUIDANCE_MARKER,
      { replyToId: commentId, updateExisting: false, isReviewComment: true, pullNumber }
    );
    core.info(`Posted guidance comment for error: ${errorType}`);

    if (commentId) {
      try {
        await setReaction(octokit, owner, repo, commentId, REACTIONS.X);
      } catch (error) {
        core.warning(`Failed to set parse-failure reaction: ${error.message}`);
      }
    }
    return;
  }

  // Valid command - check authorization before dispatching
  core.info(`Valid command parsed: ${parseResult.command} with args: ${parseResult.args.join(' ')}`);

  const octokit = github.getOctokit(process.env.GITHUB_TOKEN || core.getInput('GITHUB_TOKEN'));
  const authState = await enforceCommandAuthorization(context, octokit, owner, repo, {
    issueNumber: pullNumber,
    pullNumber,
    replyToId: commentId,
    isReviewComment: true,
  });
  if (!authState.authorized) {
    return;
  }
  const { commenter } = authState;

  // Load continuity state
  let continuityState = null;
  try {
    continuityState = await loadContinuityState(octokit, owner, repo, pullNumber);
  } catch (error) {
    core.warning(`Failed to load continuity state: ${error.message}`);
  }

  // Set acknowledgment reaction
  if (commentId && parseResult.command !== 'ask') {
    try {
      await setReaction(octokit, owner, repo, commentId, REACTIONS.EYES);
    } catch (error) {
      core.warning(`Failed to set acknowledgment reaction: ${error.message}`);
    }
  }

  // Post progress message
  await upsertComment(
    octokit,
    owner,
    repo,
    pullNumber,
    `🤖 Reviewing \`/zai ${parseResult.command}\`...\n\n${PROGRESS_MARKER}`,
    PROGRESS_MARKER,
    { replyToId: commentId, updateExisting: false, isReviewComment: true, pullNumber }
  );

  // Extract anchor metadata from review comment
  const anchorMetadata = extractReviewCommentAnchor(context.payload);
  
  // Get base and head refs from PR
  const baseRef = context.payload.pull_request?.base?.ref || null;
  const headRef = context.payload.pull_request?.head?.ref || null;

  core.info(`Authorized command from collaborator: ${commenter.login}`);
  await dispatchCommand(context, parseResult, apiKey, model, owner, repo, zaiTimeout, {
    commentId,
    continuityState,
    commenter,
    baseRef,
    headRef,
    isReviewComment: true,
    eventName: 'pull_request_review_comment',
    ...anchorMetadata,
  });
}

async function dispatchCommand(context, parseResult, apiKey, model, owner, repo, zaiTimeout, options = {}) {
  const { command, args } = parseResult;
  const pullNumber = context.payload.issue?.number || context.payload.pull_request?.number;
  const { 
    commentId = null, 
    continuityState = null, 
    commenter = null,
    baseRef = null,
    headRef = null,
    commentPath = null,
    commentLine = null,
    commentStartLine = null,
    commentDiffHunk = null,
    isReviewComment = false,
    eventName = context.eventName || 'issue_comment',
  } = options;

  const octokit = github.getOctokit(process.env.GITHUB_TOKEN || core.getInput('GITHUB_TOKEN'));

  let responseMessage = '';
  let terminalReaction = REACTIONS.ROCKET;

  // Build handler context with required fields
  const correlationId = generateCorrelationId();
  const logger = createLogger(correlationId, { 
    eventName,
    prNumber: pullNumber,
    command 
  });

  // Fetch changed files for handlers that need them
  let changedFiles = [];
  try {
    changedFiles = await fetchChangedFiles(octokit, owner, repo, pullNumber);
  } catch (error) {
    logger.warn({ error: error.message }, 'Failed to fetch changed files');
  }

  // Build base handler context with normalized context inputs
  const handlerContext = {
    octokit,
    owner,
    repo,
    issueNumber: pullNumber,
    commentId,
    changedFiles,
    apiClient: createApiClient({ timeout: zaiTimeout }),
    apiKey,
    model,
    logger,
    maxChars: DEFAULT_MAX_CHARS,
    continuityState,
    // Normalized context inputs for explain/suggest/compare handlers
    baseRef,
    headRef,
    commentPath,
    commentLine,
    commentStartLine,
    commentDiffHunk,
    isReviewComment,
    pullNumber,
  };

  switch (command) {
    case 'help':
      responseMessage = `## Z.ai Help\n\nAvailable commands:\n- \`/zai ask <question>\` - Ask a question about the code\n- \`/zai review <path>\` - Request a code review for a specific file\n- \`/zai explain <lines>\` - Explain specific lines (e.g., 10-15)\n- \`/zai suggest\` - Get improvement suggestions\n- \`/zai compare\` - Compare changes\n- \`/zai describe\` - Generate PR description from commits\n- \`/zai help\` - Show this help message\n\n${COMMENT_MARKER}`;
      break;

    case 'review':
      // Route to review handler with file path from args
      logger.info({ args }, 'Dispatching to review handler');
      
      try {
        const result = await reviewHandler.handleReviewCommand(handlerContext, args);
        if (result.success) {
          // Handler already posted the comment, no need to post again
          logger.info({ success: true }, 'Review command completed');
          return;
        } else {
          // Handler already posted error, log and return
          logger.warn({ error: result.error }, 'Review command failed');
          return;
        }
      } catch (error) {
        logger.error({ error: error.message }, 'Review handler threw error');
        terminalReaction = REACTIONS.X;
        responseMessage = `## Z.ai Code Review

**Error:** Failed to complete review. Please try again later.

${COMMENT_MARKER}`;
      }
      break;

    case 'explain': {
      // Route to explain handler with line range from args
      logger.info({ args }, 'Dispatching to explain handler');
      
      let explainArgs = args;
      if (explainArgs.length === 0 && Number.isInteger(commentLine)) {
        const anchorStart = Number.isInteger(commentStartLine) ? commentStartLine : commentLine;
        const start = Math.min(anchorStart, commentLine);
        const end = Math.max(anchorStart, commentLine);
        explainArgs = [`${start}-${end}`];
        logger.info({ start, end, commentPath }, 'Inferred explain range from review-comment anchor');
      }

      if (explainArgs.length === 0) {
        terminalReaction = REACTIONS.X;
        responseMessage = `## Z.ai Help\n\nFor \`/zai explain\`, please specify a line range.\n\nUsage: \`/zai explain 10-15\` (lines 10 to 15)\n\nYou can also use: \`/zai explain 10:15\` or \`/zai explain 10..15\`\n\n${COMMENT_MARKER}`;
        break;
      }

      // For explain, use anchor metadata if available (from review comment)
      // Otherwise, try to get it from changed files
      let filename = null;
      let fileContent = null;

      if (handlerContext.commentPath) {
        // Use anchor metadata from review comment
        filename = handlerContext.commentPath;
        // Don't use first-changed-file patch - let handler fetch content based on path
        fileContent = handlerContext.commentDiffHunk || null;
      } else {
        // Fall back to first changed file for issue_comment
        const firstChangedFile = changedFiles.find(f => f.patch);
        if (!firstChangedFile) {
          terminalReaction = REACTIONS.X;
          responseMessage = `## Z.ai Explanation

No files with changes found in this PR to explain.

${COMMENT_MARKER}`;
          break;
        }
        filename = firstChangedFile.filename;
        fileContent = firstChangedFile.patch || '';
      }

      // Add file-specific context for explain handler
      const explainContext = {
        ...handlerContext,
        filename,
        fileContent,
      };

      try {
        const result = await explainHandler.handleExplainCommand(explainContext, explainArgs);
        if (result.success) {
          logger.info({ success: true }, 'Explain command completed');
          return;
        } else {
          logger.warn({ error: result.error }, 'Explain command failed');
          return;
        }
      } catch (error) {
        logger.error({ error: error.message }, 'Explain handler threw error');
        terminalReaction = REACTIONS.X;
        responseMessage = `## Z.ai Explanation

**Error:** Failed to complete explanation. Please try again later.

${COMMENT_MARKER}`;
      }
      break;
    }
    case 'describe': {
      logger.info({ args }, 'Dispatching to describe handler');
      
      try {
        const result = await handleDescribeCommand(handlerContext, args);
        if (result.success) {
          logger.info({ success: true }, 'Describe command completed');
          return;  // Handler posts its own comment and reaction
        } else {
          logger.warn({ error: result.error }, 'Describe command failed');
          return;
        }
      } catch (error) {
        logger.error({ error: error.message }, 'Describe handler threw error');
        terminalReaction = REACTIONS.X;
        responseMessage = `## Z.ai Describe\n\n**Error:** Failed to generate description. Please try again later.\n\n${COMMENT_MARKER}`;
      }
      break;
    }

    case 'ask': {
      if (args.length === 0) {
        terminalReaction = REACTIONS.X;
        responseMessage = `## Z.ai Ask\n\nPlease provide a question. Usage: \`/zai ask <question>\`\n\n${COMMENT_MARKER}`;
        break;
      }

      try {
        const normalizedAskContext = {
          ...context,
          payload: {
            ...context.payload,
            pull_request: {
              number: pullNumber,
              title: context.payload.issue?.title || context.payload.pull_request?.title || '',
              body: context.payload.issue?.body || context.payload.pull_request?.body || '',
            },
          },
        };

        const askContext = {
          octokit,
          context: normalizedAskContext,
          commenter,
          args,
          continuityState,
          config: {
            apiKey,
            model,
            timeout: 30000,
            maxRetries: 3,
          },
          logger,
        };

        const result = await handleAskCommand(askContext);
        if (result.success) {
          logger.info({ success: true }, 'Ask command completed');
          return;
        }

        if (!result.error) {
          logger.info('Ask command silently blocked by fork policy');
          return;
        }

        terminalReaction = REACTIONS.X;
        responseMessage = `## Z.ai Ask\n\n**Error:** ${result.error}\n\n${COMMENT_MARKER}`;
      } catch (error) {
        logger.error({ error: error.message }, 'Ask handler threw error');
        terminalReaction = REACTIONS.X;
        responseMessage = `## Z.ai Ask\n\n**Error:** Failed to complete request. Please try again later.\n\n${COMMENT_MARKER}`;
      }
      break;
    }

    case 'suggest': {
      // Extract user prompt from args (everything after 'suggest')
      const userPrompt = args.join(' ').trim();
      
      const handlerContextSuggest = {
        octokit,
        context,
        payload: context.payload,
        apiKey,
        model,
        userPrompt,
        commentId,
      };
      
      core.info(`Processing suggest command with prompt: ${userPrompt.substring(0, 50)}...`);
      
      const result = await handleSuggestCommand(handlerContextSuggest);
      
      if (result.success) {
        responseMessage = `${result.response}\n\n${COMMENT_MARKER}`;
      } else {
        terminalReaction = REACTIONS.X;
        responseMessage = `## Z.ai Suggest\n\n**Error:** ${result.error}\n\n${COMMENT_MARKER}`;
      }
      break;
    }

    case 'compare': {
      const handlerContextCompare = {
        octokit,
        context,
        payload: context.payload,
        apiKey,
        model,
        commentId,
      };
      
      core.info('Processing compare command');
      
      const result = await handleCompareCommand(handlerContextCompare);
      
      if (result.success) {
        responseMessage = `${result.response}\n\n${COMMENT_MARKER}`;
      } else {
        terminalReaction = REACTIONS.X;
        responseMessage = `## Z.ai Compare\n\n**Error:** ${result.error}\n\n${COMMENT_MARKER}`;
      }
      break;
    }

    default:
      responseMessage = GUIDANCE_MESSAGES.unknown_command;
  }

  // Post or update comment (only for cases that didn't return early)
  if (!responseMessage) {
    return;
  }

  const nextState = mergeState(continuityState, {
    lastCommand: command,
    lastArgs: args.join(' '),
    lastUser: commenter?.login || 'unknown',
    turnCount: (continuityState?.turnCount || 0) + 1,
    updatedAt: new Date().toISOString(),
  });
  const responseWithState = createCommentWithState(responseMessage, nextState);

  await upsertComment(
    octokit,
    owner,
    repo,
    pullNumber,
    responseWithState,
    COMMENT_MARKER,
    {
      replyToId: commentId,
      updateExisting: false,
      isReviewComment,
      pullNumber,
    }
  );
  core.info(`Posted response for command: ${command}`);

  if (commentId) {
    try {
      await setReaction(octokit, owner, repo, commentId, terminalReaction);
    } catch (error) {
      core.warning(`Failed to set terminal reaction: ${error.message}`);
    }
  }
}

async function performReview(octokit, owner, repo, pullNumber, apiKey, model) {
  core.info(`Fetching changed files for PR #${pullNumber}...`);
  const files = await getChangedFiles(octokit, owner, repo, pullNumber);

  if (!files.some(f => f.patch)) {
    return `## Z.ai Code Review

No patchable changes found.${COMMENT_MARKER}`;
  }

  const prompt = buildPrompt(files);

  core.info(`Sending ${files.length} file(s) to Z.ai for review...`);
  const review = await callZaiApi(apiKey, model, prompt);

  return `## Z.ai Code Review

${review}

${COMMENT_MARKER}`;
}

run().catch(err => core.setFailed(err.message));
