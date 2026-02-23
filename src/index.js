const core = require('@actions/core');
const github = require('@actions/github');
const https = require('https');

const { getEventType, isBotComment, shouldProcessEvent, getEventInfo } = require('./lib/events.js');
const { parseCommand, isValid } = require('./lib/commands.js');
const { checkForkAuthorization, getUnauthorizedMessage } = require('./lib/auth.js');
const { handleSuggestCommand } = require('./lib/handlers/suggest.js');
const { handleCompareCommand } = require('./lib/handlers/compare.js');
const reviewHandler = require('./lib/handlers/review.js');
const explainHandler = require('./lib/handlers/explain.js');

const { truncateContext, DEFAULT_MAX_CHARS, fetchChangedFiles } = require('./lib/context.js');
const { loadContinuityState, saveContinuityState, mergeState, MAX_STATE_SIZE } = require('./lib/continuity.js');
const { createApiClient } = require('./lib/api.js');
const { createLogger, generateCorrelationId } = require('./lib/logging.js');
const ZAI_API_URL = 'https://api.z.ai/api/coding/paas/v4/chat/completions';
const COMMENT_MARKER = '<!-- zai-code-review -->';
const CONTINUITY_MARKER = '<!-- zai-continuity:';

// Safe guidance messages for error cases
const GUIDANCE_MESSAGES = {
  unknown_command: `## Z.ai Help

Unknown command. Available commands:
- \`/zai ask <question>\` - Ask a question about the code
- \`/zai review\` - Request a full code review
- \`/zai explain <lines>\` - Explain specific lines
- \`/zai suggest\` - Get improvement suggestions
- \`/zai compare\` - Compare changes
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

async function run() {
  const apiKey = core.getInput('ZAI_API_KEY', { required: true });
  const model = core.getInput('ZAI_MODEL') || 'glm-4.7';
  

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
    await handleIssueCommentEvent(context, apiKey, model, owner, repo);
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

async function handleIssueCommentEvent(context, apiKey, model, owner, repo) {
  const comment = context.payload.comment;
  const commentBody = comment?.body || '';

  core.info(`Processing issue_comment on PR: ${commentBody.substring(0, 50)}...`);

  // Parse the command from comment body
  const parseResult = parseCommand(commentBody);

  // If parsing failed, post safe guidance message
  if (!isValid(parseResult)) {
    const errorType = parseResult.error.type;
    const guidance = GUIDANCE_MESSAGES[errorType] || GUIDANCE_MESSAGES.malformed_input;

    const octokit = github.getOctokit(process.env.GITHUB_TOKEN || core.getInput('GITHUB_TOKEN'));
    const pullNumber = context.payload.issue?.number;

    if (!pullNumber) {
      core.setFailed('No issue/PR number found.');
      return;
    }

    // Check if there's already a comment from us
    const { data: comments } = await octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number: pullNumber,
    });

    const existingBotComment = comments.find(c =>
      c.user?.type === 'Bot' && c.body.includes(COMMENT_MARKER)
    );

    if (existingBotComment) {
      await octokit.rest.issues.updateComment({
        owner,
        repo,
        comment_id: existingBotComment.id,
        body: guidance,
      });
      core.info(`Updated guidance comment for error: ${errorType}`);
    } else {
      await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: pullNumber,
        body: guidance,
      });
      core.info(`Posted guidance comment for error: ${errorType}`);
    }
    return;
  }

  // Valid command - check authorization before dispatching
  core.info(`Valid command parsed: ${parseResult.command} with args: ${parseResult.args.join(' ')}`);

  // Get commenter info for auth check
  const commenter = comment?.user;
  const octokit = github.getOctokit(process.env.GITHUB_TOKEN || core.getInput('GITHUB_TOKEN'));

  // Check authorization using fork-aware auth check
  const authResult = await checkForkAuthorization(octokit, context, commenter);

  if (!authResult.authorized) {
    // Silent block for fork PRs (reason: null per SECURITY.md)
    if (authResult.reason === null) {
      core.info(`Silently blocking command from non-collaborator on fork PR: ${commenter?.login || 'unknown'}`);
      return;
    }

    // For regular PRs, post an error message
    core.info(`Unauthorized command attempt from: ${commenter?.login || 'unknown'}`);
    const pullNumber = context.payload.issue?.number;
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: pullNumber,
      body: getUnauthorizedMessage(),
    });
    return;
  }

  core.info(`Authorized command from collaborator: ${commenter.login}`);
  await dispatchCommand(context, parseResult, apiKey, model, owner, repo);
}

async function dispatchCommand(context, parseResult, apiKey, model, owner, repo) {
  const { command, args } = parseResult;
  const pullNumber = context.payload.issue?.number;

  const octokit = github.getOctokit(process.env.GITHUB_TOKEN || core.getInput('GITHUB_TOKEN'));

  let responseMessage = '';

  // Build handler context with required fields
  const correlationId = generateCorrelationId();
  const logger = createLogger(correlationId, { 
    eventName: 'issue_comment', 
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

  // Build base handler context
  const handlerContext = {
    octokit,
    owner,
    repo,
    issueNumber: pullNumber,
    changedFiles,
    apiClient: createApiClient(),
    apiKey,
    model,
    logger,
    maxChars: DEFAULT_MAX_CHARS,
  };

  switch (command) {
    case 'help':
      responseMessage = `## Z.ai Help\n\nAvailable commands:\n- \`/zai ask <question>\` - Ask a question about the code\n- \`/zai review <path>\` - Request a code review for a specific file\n- \`/zai explain <lines>\` - Explain specific lines (e.g., 10-15)\n- \`/zai suggest\` - Get improvement suggestions\n- \`/zai compare\` - Compare changes\n- \`/zai help\` - Show this help message\n\n${COMMENT_MARKER}`;
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
        responseMessage = `## Z.ai Code Review

**Error:** Failed to complete review. Please try again later.

${COMMENT_MARKER}`;
      }
      break;

    case 'explain':
      // Route to explain handler with line range from args
      logger.info({ args }, 'Dispatching to explain handler');
      
      // Check if line range argument is provided
      if (args.length === 0) {
        responseMessage = `## Z.ai Help\n\nFor \`/zai explain\`, please specify a line range.\n\nUsage: \`/zai explain 10-15\` (lines 10 to 15)\n\nYou can also use: \`/zai explain 10:15\` or \`/zai explain 10..15\`\n\n${COMMENT_MARKER}`;
        break;
      }

      // For explain, we need file content. Try to get it from changed files.
      // If no specific file is mentioned in args, use the first changed file
      const firstChangedFile = changedFiles.find(f => f.patch);
      if (!firstChangedFile) {
        responseMessage = `## Z.ai Explanation

No files with changes found in this PR to explain.

${COMMENT_MARKER}`;
        break;
      }

      // Add file-specific context for explain handler
      const explainContext = {
        ...handlerContext,
        filename: firstChangedFile.filename,
        fileContent: firstChangedFile.patch || '',
      };

      try {
        const result = await explainHandler.handleExplainCommand(explainContext, args);
        if (result.success) {
          logger.info({ success: true }, 'Explain command completed');
          return;
        } else {
          logger.warn({ error: result.error }, 'Explain command failed');
          return;
        }
      } catch (error) {
        logger.error({ error: error.message }, 'Explain handler threw error');
        responseMessage = `## Z.ai Explanation

**Error:** Failed to complete explanation. Please try again later.

${COMMENT_MARKER}`;
      }
      break;

    case 'ask':
      // Placeholder response - TODO: implement actual command handler
      responseMessage = `## Z.ai: ask\n\nCommand \`ask\` with args: \`${args.join(' ')}\` received.\n\nThis feature is coming soon!${COMMENT_MARKER}`;
      break;

    case 'suggest': {
      // Extract user prompt from args (everything after 'suggest')
      const userPrompt = args.join(' ').trim();
      
      const handlerContextSuggest = {
        octokit,
        context,
        payload: context.payload,
        apiKey,
        model,
        userPrompt
      };
      
      core.info(`Processing suggest command with prompt: ${userPrompt.substring(0, 50)}...`);
      
      const result = await handleSuggestCommand(handlerContextSuggest);
      
      if (result.success) {
        responseMessage = `${result.response}\n\n${COMMENT_MARKER}`;
      } else {
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
        model
      };
      
      core.info('Processing compare command');
      
      const result = await handleCompareCommand(handlerContextCompare);
      
      if (result.success) {
        responseMessage = `${result.response}\n\n${COMMENT_MARKER}`;
      } else {
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

  const { data: comments } = await octokit.rest.issues.listComments({
    owner,
    repo,
    issue_number: pullNumber,
  });

  const existingBotComment = comments.find(c =>
    c.user?.type === 'Bot' && c.body.includes(COMMENT_MARKER)
  );

  if (existingBotComment) {
    await octokit.rest.issues.updateComment({
      owner,
      repo,
      comment_id: existingBotComment.id,
      body: responseMessage,
    });
    core.info(`Updated response for command: ${command}`);
  } else {
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: pullNumber,
      body: responseMessage,
    });
    core.info(`Posted response for command: ${command}`);
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
