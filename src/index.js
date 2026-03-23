const core = require('@actions/core');
const github = require('@actions/github');
const https = require('node:https');

const { getEventType, shouldProcessEvent, extractReviewCommentAnchor } = require('./lib/events.js');
const { parseCommand, isValid } = require('./lib/commands.js');
const { checkForkAuthorization, getUnauthorizedMessage, getCommenter } = require('./lib/auth.js');
const {
  DEFAULT_LARGE_PR_FILE_THRESHOLD,
  DEFAULT_REVIEW_BATCH_CHARS,
  DEFAULT_MAX_FILES_PER_BATCH,
  DEFAULT_MAX_PATCH_CHARS,
  buildCoverageNotes,
  buildFallbackReview,
  buildPrompt: buildBatchedReviewPrompt,
  buildSynthesisPrompt,
  createReviewBatches,
  isContextLimitError,
  isLargePr,
} = require('./lib/auto-review.js');
const {
  fetchAllChangedFiles,
  fetchChangedFiles: fetchChangedFilesPaginated,
  MAX_PR_FILES_API_LIMIT,
} = require('./lib/changed-files');
const { handleAskCommand } = require('./lib/handlers/ask.js');
const { handleDescribeCommand } = require('./lib/handlers/describe');
const { handleImpactCommand } = require('./lib/handlers/impact');
const reviewHandler = require('./lib/handlers/review.js');
const explainHandler = require('./lib/handlers/explain.js');

const { DEFAULT_MAX_CHARS, fetchChangedFiles } = require('./lib/context.js');
const { loadContinuityState, mergeState, createCommentWithState } = require('./lib/continuity.js');
const { REACTIONS, setReaction, upsertComment } = require('./lib/comments.js');
const { createApiClient } = require('./lib/api.js');
const { createLogger, generateCorrelationId } = require('./lib/logging.js');
const ZAI_API_URL = 'https://api.z.ai/api/coding/paas/v4/chat/completions';
const COMMENT_MARKER = '<!-- zai-code-review -->';
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
- \`/zai describe\` - Generate PR description from commits
- \`/zai impact\` - Analyze the potential impact of changes
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
  return fetchChangedFilesPaginated(octokit, owner, repo, pullNumber);
}

function buildPrompt(files) {
  const formattedFiles = files
    .filter(f => f.patch)
    .map(f => `<file name="${f.filename}">\n<diff>\n${f.patch}\n</diff>\n</file>`)
    .join('\n\n');

  return `Please review the following Pull Request changes based on your system instructions.

<pull_request_changes>
${formattedFiles}
</pull_request_changes>`;
}

function callZaiApi(apiKey, model, prompt) {
  return new Promise((resolve, reject) => {
    const systemPrompt = `You are an Elite Staff Engineer and meticulous Code Reviewer. Your objective is to thoroughly analyze Pull Request diffs, identify potential bugs, security vulnerabilities, and architectural flaws, and provide constructive, actionable feedback.

### Core Instructions:
1. **Focus on Impact:** Prioritize logic errors, security risks (e.g., injections, unvalidated input), performance bottlenecks, and bad practices.
2. **Ignore Trivialities:** Do not comment on minor styling or formatting issues that a linter should catch (e.g., trailing spaces, missing semicolons) unless they affect readability significantly.
3. **Be Actionable:** If you point out a problem, briefly explain *why* it is a problem and provide a short code snippet demonstrating the fix.
4. **Tone:** Maintain a professional, objective, and encouraging tone.

### Required Output Format:
You MUST format your response strictly using the Markdown structure below. If a section has no issues, write "None detected."

**## 🔍 Review Summary**
[1-2 sentences summarizing the overall quality and purpose of the changes.]

**## 🚨 Critical Issues & Bugs**
* [File Name]: [Description of the critical issue and potential impact]

**## 💡 Suggestions & Best Practices**
* [File Name]: [Suggestions for refactoring, performance improvements, or readability]

**## 📊 Final Assessment**
[You MUST conclude your review with exactly one of the following ratings in bold, followed by a brief justification: **Good**, **Normal**, or **Very Bad**]
* **Rating:** [Insert Rating]
* **Reason:** [1-2 sentences explaining why this rating was given]`;

    const body = JSON.stringify({
      model,
      messages: [
        {
          role: 'system',
          content: systemPrompt,
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

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function getReviewConfig(_core = core, overrides = {}) {
  const input = (name, fallback) => {
    const overrideValue = overrides[name];
    if (overrideValue !== undefined && overrideValue !== null && overrideValue !== '') {
      return overrideValue;
    }

    const inputValue = _core.getInput(name);
    return inputValue || fallback;
  };

  return {
    largePrFileThreshold: parsePositiveInteger(
      input('ZAI_AUTO_REVIEW_LARGE_PR_FILE_THRESHOLD', String(DEFAULT_LARGE_PR_FILE_THRESHOLD)),
      DEFAULT_LARGE_PR_FILE_THRESHOLD
    ),
    maxBatchChars: parsePositiveInteger(
      input('ZAI_AUTO_REVIEW_MAX_BATCH_CHARS', String(DEFAULT_REVIEW_BATCH_CHARS)),
      DEFAULT_REVIEW_BATCH_CHARS
    ),
    maxFilesPerBatch: parsePositiveInteger(
      input('ZAI_AUTO_REVIEW_MAX_FILES_PER_BATCH', String(DEFAULT_MAX_FILES_PER_BATCH)),
      DEFAULT_MAX_FILES_PER_BATCH
    ),
    maxPatchChars: parsePositiveInteger(
      input('ZAI_AUTO_REVIEW_MAX_PATCH_CHARS', String(DEFAULT_MAX_PATCH_CHARS)),
      DEFAULT_MAX_PATCH_CHARS
    ),
  };
}

async function executeReviewBatch(entries, state, deps = {}) {
  const {
    callZaiApi: _callZaiApi = callZaiApi,
    buildPrompt: _buildPrompt = buildBatchedReviewPrompt,
    core: _core = core,
  } = deps;

  const prompt = _buildPrompt(entries, {
    batchNumber: state.batchNumber,
    totalBatches: state.totalBatches,
  });

  try {
    const review = await _callZaiApi(state.apiKey, state.model, prompt);
    return [{
      review,
      coverage: {
        batchNumber: state.batchNumber,
        entryCount: entries.length,
        fileCount: new Set(entries.map(entry => entry.filename)).size,
      },
    }];
  } catch (error) {
    if (!isContextLimitError(error) || entries.length === 0) {
      throw error;
    }

    if (entries.length === 1) {
      throw error;
    }

    const midpoint = Math.ceil(entries.length / 2);
    _core.info(`Batch ${state.batchNumber}/${state.totalBatches} exceeded context budget, retrying as two smaller sub-batches.`);
    const left = await executeReviewBatch(entries.slice(0, midpoint), state, deps);
    const right = await executeReviewBatch(entries.slice(midpoint), state, deps);
    return [...left, ...right];
  }
}

async function runLargePrReview(files, state, deps = {}) {
  const {
    callZaiApi: _callZaiApi = callZaiApi,
    createReviewBatches: _createReviewBatches = createReviewBatches,
    buildSynthesisPrompt: _buildSynthesisPrompt = buildSynthesisPrompt,
    buildFallbackReview: _buildFallbackReview = buildFallbackReview,
    buildCoverageNotes: _buildCoverageNotes = buildCoverageNotes,
    core: _core = core,
  } = deps;

  const { batches, metadata } = _createReviewBatches(files, state.reviewConfig);
  const collectedReviews = [];

  for (let index = 0; index < batches.length; index += 1) {
    const batchNumber = index + 1;
    const batchEntries = batches[index];
    _core.info(`Reviewing large PR batch ${batchNumber}/${batches.length} with ${batchEntries.length} chunk(s).`);
    const batchResults = await executeReviewBatch(batchEntries, {
      apiKey: state.apiKey,
      model: state.model,
      batchNumber,
      totalBatches: batches.length,
    }, deps);
    collectedReviews.push(...batchResults);
  }

  const reviewedFiles = new Set(files.filter(file => file.patch).map(file => file.filename)).size;
  const synthesisMetadata = {
    reviewedFiles,
    totalBatches: collectedReviews.length,
    splitFileCount: metadata.splitFileCount,
    limitReached: state.limitReached,
  };

  const coverageNotes = _buildCoverageNotes(synthesisMetadata);
  const synthesisPrompt = _buildSynthesisPrompt(collectedReviews, synthesisMetadata);

  try {
    const synthesizedReview = await _callZaiApi(state.apiKey, state.model, synthesisPrompt);
    const coverageBlock = coverageNotes.map(note => `* ${note}`).join('\n');

    if (synthesizedReview.includes('## Coverage Notes')) {
      return `${synthesizedReview}\n${coverageBlock ? `\n${coverageBlock}` : ''}`;
    }

    return `${synthesizedReview}\n\n## Coverage Notes\n${coverageBlock}`;
  } catch (error) {
    _core.warning(`Final review synthesis failed, falling back to concatenated batch output: ${error.message}`);
    return _buildFallbackReview(collectedReviews, synthesisMetadata);
  }
}

async function enforceCommandAuthorization(context, octokit, owner, repo, options = {}, deps = {}) {
  const {
    issueNumber,
    pullNumber,
    replyToId,
    isReviewComment = false,
  } = options;
  const {
    core: _core = core,
    getCommenter: _getCommenter = getCommenter,
    checkForkAuthorization: _checkForkAuthorization = checkForkAuthorization,
    getUnauthorizedMessage: _getUnauthorizedMessage = getUnauthorizedMessage,
    upsertComment: _upsertComment = upsertComment,
    setReaction: _setReaction = setReaction,
  } = deps;

  const commenter = _getCommenter(context);
  const authResult = await _checkForkAuthorization(octokit, context, commenter);

  if (authResult.authorized) {
    return { authorized: true, commenter };
  }

  if (authResult.reason === null) {
    _core.info(`Silently blocking command from non-collaborator on fork PR: ${commenter?.login || 'unknown'}`);
    return { authorized: false, commenter, silent: true };
  }

  const authMessage = _getUnauthorizedMessage(authResult.reason);
  _core.info(`Command authorization failed for ${commenter?.login || 'unknown'}: ${authResult.reason}`);

  await _upsertComment(
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
      await _setReaction(octokit, owner, repo, replyToId, REACTIONS.X);
    } catch (error) {
      _core.warning(`Failed to set auth-failure reaction: ${error.message}`);
    }
  }

  return { authorized: false, commenter, silent: false };
}

async function run() {
  const apiKey = core.getInput('ZAI_API_KEY', { required: true });
  const model = core.getInput('ZAI_MODEL') || 'glm-4.7';
  const zaiTimeout = parseInt(core.getInput('ZAI_TIMEOUT') || '30000', 10);
  const reviewConfig = getReviewConfig(core);

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
    await handlePullRequestEvent(context, apiKey, model, owner, repo, { reviewConfig });
  } else if (eventType === 'issue_comment_pr') {
    await handleIssueCommentEvent(context, apiKey, model, owner, repo, zaiTimeout);
  } else if (eventType === 'pull_request_review_comment') {
    await handlePullRequestReviewCommentEvent(context, apiKey, model, owner, repo, zaiTimeout);
  }
}

async function handlePullRequestEvent(context, apiKey, model, owner, repo, deps = {}) {
  const {
    core: _core = core,
    github: _github = github,
    getChangedFiles: _getChangedFiles = getChangedFiles,
    buildPrompt: _buildPrompt = buildPrompt,
    callZaiApi: _callZaiApi = callZaiApi,
    COMMENT_MARKER: _MARKER = COMMENT_MARKER,
    reviewConfig = getReviewConfig(_core),
    fetchAllChangedFiles: _fetchAllChangedFiles = fetchAllChangedFiles,
    runLargePrReview: _runLargePrReview = runLargePrReview,
  } = deps;

  const pullNumber = context.payload.pull_request?.number;

  if (!pullNumber) {
    _core.setFailed('No pull request number found.');
    return { success: false, error: 'No pull request number found.' };
  }

  const token = process.env.GITHUB_TOKEN || _core.getInput('GITHUB_TOKEN');
  const octokit = _github.getOctokit(token);

  _core.info(`Fetching changed files for PR #${pullNumber}...`);
  let filesResult;
  if (_fetchAllChangedFiles) {
    const fetched = await _fetchAllChangedFiles(octokit, owner, repo, pullNumber);
    filesResult = Array.isArray(fetched)
      ? { files: fetched, limitReached: false }
      : { files: fetched.files || [], limitReached: Boolean(fetched.limitReached) };
  } else {
    filesResult = { files: await _getChangedFiles(octokit, owner, repo, pullNumber), limitReached: false };
  }
  const files = filesResult.files;

  if (!files.some(f => f.patch)) {
    _core.info('No patchable changes found. Skipping review.');
    return { success: true, skipped: true, reason: 'No patchable changes' };
  }

  const patchableFiles = files.filter(file => file.patch);
  let review;

  if (isLargePr(patchableFiles, reviewConfig)) {
    _core.info(`Large PR detected (${patchableFiles.length} patchable file(s)); switching to batched review mode.`);
    review = await _runLargePrReview(patchableFiles, {
      apiKey,
      model,
      reviewConfig,
      limitReached: Boolean(filesResult.limitReached),
    }, {
      callZaiApi: _callZaiApi,
      core: _core,
    });
  } else {
    const prompt = _buildPrompt(files);
    _core.info(`Sending ${files.length} file(s) to Z.ai for review...`);
    review = await _callZaiApi(apiKey, model, prompt);
  }

  if (filesResult.limitReached) {
    _core.warning(`GitHub changed-files API limit (${MAX_PR_FILES_API_LIMIT}) reached for PR #${pullNumber}. Review coverage may be incomplete beyond that platform limit.`);
  }

  const body = `## Z.ai Code Review\n\n${review}\n\n${_MARKER}`;

  const { data: comments } = await octokit.rest.issues.listComments({
    owner,
    repo,
    issue_number: pullNumber,
  });
  const existing = comments.find(c => c.body.includes(_MARKER));

  if (existing) {
    await octokit.rest.issues.updateComment({
      owner,
      repo,
      comment_id: existing.id,
      body,
    });
    _core.info('Review comment updated.');
    return { success: true, action: 'updated', commentId: existing.id };
  } else {
    const result = await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: pullNumber,
      body,
    });
    _core.info('Review comment posted.');
    return { success: true, action: 'created', commentId: result.data.id };
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

  // If parsing failed, post safe guidance message only for actual command attempts
  if (!isValid(parseResult)) {
    const errorType = parseResult.error.type;

    // Only respond if user tried to use a command but got it wrong
    // SILENTLY IGNORE comments that don't try to use /zai at all (MALFORMED_INPUT)
    if (errorType !== 'malformed_input') {
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
    } else {
      core.info(`Ignoring comment without /zai command intent`);
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
  if (!authState.authorized && !authState.silent) {
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
  if (!authState.authorized && !authState.silent) {
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

async function dispatchCommand(context, parseResult, apiKey, model, owner, repo, zaiTimeout, options = {}, deps = {}) {
  const {
    core: _core = core,
    github: _github = github,
    generateCorrelationId: _generateCorrelationId = generateCorrelationId,
    createLogger: _createLogger = createLogger,
    fetchChangedFiles: _fetchChangedFiles = fetchChangedFiles,
    createApiClient: _createApiClient = createApiClient,
    reviewHandler: _reviewHandler = reviewHandler,
    explainHandler: _explainHandler = explainHandler,
    handleDescribeCommand: _handleDescribeCommand = handleDescribeCommand,
    handleAskCommand: _handleAskCommand = handleAskCommand,
    handleImpactCommand: _handleImpactCommand = handleImpactCommand,
    upsertComment: _upsertComment = upsertComment,
    setReaction: _setReaction = setReaction,
    mergeState: _mergeState = mergeState,
    createCommentWithState: _createCommentWithState = createCommentWithState,
    COMMENT_MARKER: _COMMENT_MARKER = COMMENT_MARKER,
    REACTIONS: _REACTIONS = REACTIONS,
  } = deps;

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

  const octokit = _github.getOctokit(process.env.GITHUB_TOKEN || _core.getInput('GITHUB_TOKEN'));

  let responseMessage = '';
  let terminalReaction = _REACTIONS.ROCKET;

  const correlationId = _generateCorrelationId();
  const logger = _createLogger(correlationId, { 
    eventName,
    prNumber: pullNumber,
    command 
  });

  let changedFiles = [];
  try {
    changedFiles = await _fetchChangedFiles(octokit, owner, repo, pullNumber);
  } catch (error) {
    logger.warn({ error: error.message }, 'Failed to fetch changed files');
  }

  const handlerContext = {
    octokit,
    owner,
    repo,
    issueNumber: pullNumber,
    commentId,
    changedFiles,
    apiClient: _createApiClient({ timeout: zaiTimeout }),
    apiKey,
    model,
    logger,
    maxChars: DEFAULT_MAX_CHARS,
    continuityState,
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
      responseMessage = `## Z.ai Help\n\nAvailable commands:\n- \`/zai ask <question>\` - Ask a question about the code\n- \`/zai review <path>\` - Request a code review for a specific file\n- \`/zai explain <lines>\` - Explain specific lines (e.g., 10-15)\n- \`/zai describe\` - Generate PR description from commits\n- \`/zai impact\` - Analyze the potential impact of changes\n- \`/zai help\` - Show this help message\n\n${_COMMENT_MARKER}`;
      break;

    case 'review':
      logger.info({ args }, 'Dispatching to review handler');
      
      try {
        const result = await _reviewHandler.handleReviewCommand(handlerContext, args);
        if (result.success) {
          logger.info({ success: true }, 'Review command completed');
          return { success: true };
        } else {
          logger.warn({ error: result.error }, 'Review command failed');
          return { success: false, error: result.error };
        }
      } catch (error) {
        logger.error({ error: error.message }, 'Review handler threw error');
        terminalReaction = _REACTIONS.X;
        responseMessage = `## Z.ai Code Review

**Error:** Failed to complete review. Please try again later.

${_COMMENT_MARKER}`;
      }
      break;

    case 'explain': {
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
        terminalReaction = _REACTIONS.X;
        responseMessage = `## Z.ai Help\n\nFor \`/zai explain\`, please specify a line range.\n\nUsage: \`/zai explain 10-15\` (lines 10 to 15)\n\nYou can also use: \`/zai explain 10:15\` or \`/zai explain 10..15\`\n\n${_COMMENT_MARKER}`;
        break;
      }

      let filename = null;
      let fileContent = null;

      if (handlerContext.commentPath) {
        filename = handlerContext.commentPath;
        fileContent = handlerContext.commentDiffHunk || null;
      } else {
        const firstChangedFile = changedFiles.find(f => f.patch);
        if (!firstChangedFile) {
          terminalReaction = _REACTIONS.X;
          responseMessage = `## Z.ai Explanation

No files with changes found in this PR to explain.

${_COMMENT_MARKER}`;
          break;
        }
        filename = firstChangedFile.filename;
        fileContent = firstChangedFile.patch || '';
      }

      const explainContext = {
        ...handlerContext,
        filename,
        fileContent,
      };

      try {
        const result = await _explainHandler.handleExplainCommand(explainContext, explainArgs);
        if (result.success) {
          logger.info({ success: true }, 'Explain command completed');
          return { success: true };
        } else {
          logger.warn({ error: result.error }, 'Explain command failed');
          return { success: false, error: result.error };
        }
      } catch (error) {
        logger.error({ error: error.message }, 'Explain handler threw error');
        terminalReaction = _REACTIONS.X;
        responseMessage = `## Z.ai Explanation

**Error:** Failed to complete explanation. Please try again later.

${_COMMENT_MARKER}`;
      }
      break;
    }
    case 'describe': {
      logger.info({ args }, 'Dispatching to describe handler');
      
      try {
        const result = await _handleDescribeCommand(handlerContext, args);
        if (result.success) {
          logger.info({ success: true }, 'Describe command completed');
          return { success: true };
        } else {
          logger.warn({ error: result.error }, 'Describe command failed');
          return { success: false, error: result.error };
        }
      } catch (error) {
        logger.error({ error: error.message }, 'Describe handler threw error');
        terminalReaction = _REACTIONS.X;
        responseMessage = `## Z.ai Describe\n\n**Error:** Failed to generate description. Please try again later.\n\n${_COMMENT_MARKER}`;
      }
      break;
    }

    case 'ask': {
      if (args.length === 0) {
        terminalReaction = _REACTIONS.X;
        responseMessage = `## Z.ai Ask\n\nPlease provide a question. Usage: \`/zai ask <question>\`\n\n${_COMMENT_MARKER}`;
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

        const result = await _handleAskCommand(askContext);
        if (result.success) {
          logger.info({ success: true }, 'Ask command completed');
          return { success: true };
        }

        if (!result.error) {
          logger.info('Ask command silently blocked by fork policy');
          return { success: true, silent: true };
        }

        terminalReaction = _REACTIONS.X;
        responseMessage = `## Z.ai Ask\n\n**Error:** ${result.error}\n\n${_COMMENT_MARKER}`;
      } catch (error) {
        logger.error({ error: error.message }, 'Ask handler threw error');
        terminalReaction = _REACTIONS.X;
        responseMessage = `## Z.ai Ask\n\n**Error:** Failed to complete request. Please try again later.\n\n${_COMMENT_MARKER}`;
      }
      break;
    }

    case 'impact': {
      const impactContext = {
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
        baseRef,
        headRef,
        pullNumber,
      };

      core.info('Processing impact command');

      const result = await handleImpactCommand(impactContext, args);

      // Impact handler manages its own comment posting via upsertComment
      // So we return early and don't post a duplicate comment
      if (result.success) {
        terminalReaction = REACTIONS.ROCKET;
      } else {
        terminalReaction = REACTIONS.X;
      }
      return;
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

// Export dispatchCommand for testing
module.exports = {
  buildPrompt,
  getChangedFiles,
  getReviewConfig,
  runLargePrReview,
  enforceCommandAuthorization,
  handlePullRequestEvent,
  dispatchCommand,
  GUIDANCE_MESSAGES,
  COMMENT_MARKER,
  GUIDANCE_MARKER,
  PROGRESS_MARKER,
  AUTH_MARKER
};

run().catch(error => {
  core.setFailed(error.message);
});
