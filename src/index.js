const core = require('@actions/core');
const github = require('@actions/github');
const https = require('https');

const { getEventType, isBotComment, shouldProcessEvent, getEventInfo } = require('./lib/events.js');
const { parseCommand, isValid } = require('./lib/commands.js');
const { checkForkAuthorization, getUnauthorizedMessage } = require('./lib/auth.js');

const ZAI_API_URL = 'https://api.z.ai/api/coding/paas/v4/chat/completions';
const COMMENT_MARKER = '<!-- zai-code-review -->';

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

I couldn't understand that command. Commands should start with \`/zai\` or \`@zai-bot\`.

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
    .map(f => `### ${f.filename} (${f.status})\n\`\`\`diff\n${f.patch}\n\`\`\``)
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

  switch (command) {
    case 'help':
      responseMessage = `## Z.ai Help

Available commands:
- \`/zai ask <question>\` - Ask a question about the code
- \`/zai review\` - Request a full code review  
- \`/zai explain <lines>\` - Explain specific lines
- \`/zai suggest\` - Get improvement suggestions
- \`/zai compare\` - Compare changes
- \`/zai help\` - Show this help message

${COMMENT_MARKER}`;
      break;

    case 'review':
      responseMessage = await performReview(octokit, owner, repo, pullNumber, apiKey, model);
      break;

    case 'ask':
    case 'explain':
    case 'suggest':
    case 'compare':
      // Placeholder responses - TODO: implement actual command handlers
      responseMessage = `## Z.ai: ${command}

Command \`${command}\` with args: \`${args.join(' ')}\` received.

This feature is coming soon!${COMMENT_MARKER}`;
      break;

    default:
      responseMessage = GUIDANCE_MESSAGES.unknown_command;
  }

  // Post or update comment
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
