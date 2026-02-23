const { truncateContext, DEFAULT_MAX_CHARS } = require('../context');
const { createApiClient } = require('../api');
const { createLogger, generateCorrelationId, getUserMessage } = require('../logging');
const { REACTIONS, setReaction } = require('../comments');
const { fetchFileAtRef, resolvePrRefs, fetchPrFiles } = require('../pr-context');

// Constants for file comparison limits
const MAX_COMPARE_FILES = 5;
const MAX_FILE_CHARS = 15000;

/**
 * Builds a comparison prompt with old and new versions of changed files.
 * @param {Array} filesData - Array of file objects with {filename, status, oldVersion, newVersion}
 * @param {number} maxChars - Maximum characters for the prompt
 * @returns {string} Formatted prompt for comparison
 */
function buildComparePrompt(filesData, maxChars = MAX_FILE_CHARS, totalChangedFiles = null) {
  const fileSections = filesData.map(file => {
    const { filename, status, oldVersion, newVersion } = file;
    
    let oldContent = oldVersion || '[File did not exist in base branch]';
    let newContent = newVersion || '[File was deleted in this PR]';
    
    // Truncate individual file contents if needed
    if (oldVersion && oldVersion.length > MAX_FILE_CHARS) {
      oldContent = `${oldVersion.substring(0, MAX_FILE_CHARS)}\n...[truncated, ${oldVersion.length - MAX_FILE_CHARS} chars omitted]`;
    }
    if (newVersion && newVersion.length > MAX_FILE_CHARS) {
      newContent = `${newVersion.substring(0, MAX_FILE_CHARS)}\n...[truncated, ${newVersion.length - MAX_FILE_CHARS} chars omitted]`;
    }
    
    return `### ${filename} (${status})

Compare the old logic with the new logic in this PR.
<old_version>
${oldContent}
</old_version>
<new_version>
${newContent}
</new_version>

Task: Summarize the functional changes. Did the behavior change? Are there any breaking changes for API consumers? Focus on 'what' changed in behavior, not just 'how' the syntax changed.
`;
  });
  
  let prompt = `You are an expert code reviewer. Compare the OLD version with the NEW version in the following pull request changes.

Analyze the differences and provide:
1. What changed between old and new versions
2. Key differences in approach or implementation
3. Potential implications of these changes
4. Any concerns or things to watch out for

## Changed Files:\n\n`;
  
  prompt += fileSections.join('\n\n');
  
  // Add note if there are more files than we can compare
  if (totalChangedFiles && totalChangedFiles > MAX_COMPARE_FILES) {
    prompt += `\n\n[Comparison limited to first ${MAX_COMPARE_FILES} of ${totalChangedFiles} changed files]`;
  }
  
  // Truncate the entire prompt if needed
  const truncated = truncateContext(prompt, maxChars);
  return truncated.content;
}

function formatCompareResponse(comparison) {
  if (!comparison.includes('```')) {
    return `## Old vs New Comparison\n\n${comparison}`;
  }
  return `## Old vs New Comparison\n\n${comparison}`;
}

async function handleCompareCommand(context) {
  const { octokit, context: githubContext, payload, apiKey, model, commentId } = context;
  const { owner, repo } = githubContext.repo;

  const correlationId = generateCorrelationId();
  const logger = createLogger(correlationId, {
    eventName: githubContext.eventName,
    prNumber: payload.pull_request?.number,
    command: 'compare',
  });

  logger.info({}, 'Processing compare command');

  try {
    const pullNumber = payload.pull_request?.number || payload.issue?.number;

    if (!pullNumber) {
      if (commentId) {
        await setReaction(octokit, owner, repo, commentId, REACTIONS.X);
      }
      return {
        success: false,
        error: 'No pull request number found.',
      };
    }

    logger.info({ pullNumber }, 'Resolving PR refs');

    // Step 1: Resolve PR base and head refs
    const refsResult = await resolvePrRefs(octokit, owner, repo, pullNumber);
    if (!refsResult.success) {
      logger.warn({ error: refsResult.error }, 'Failed to resolve PR refs, falling back to base/head from payload');
    }

    const baseRef = refsResult.success ? refsResult.data.base.sha : (payload.pull_request?.base?.sha || 'HEAD');
    const headRef = refsResult.success ? refsResult.data.head.sha : (payload.pull_request?.head?.sha || 'HEAD');
    const baseBranch = refsResult.success ? refsResult.data.base.ref : (payload.pull_request?.base?.ref || 'base');
    const headBranch = refsResult.success ? refsResult.data.head.ref : (payload.pull_request?.head?.ref || 'head');

    logger.info({ baseRef, headRef, baseBranch, headBranch }, 'Resolved PR refs');

    // Step 2: Fetch changed files list
    logger.info({ pullNumber }, 'Fetching changed files');

    const filesResult = await fetchPrFiles(octokit, owner, repo, pullNumber);
    if (!filesResult.success || !filesResult.data || filesResult.data.length === 0) {
      if (commentId) {
        await setReaction(octokit, owner, repo, commentId, REACTIONS.X);
      }
      return {
        success: false,
        error: filesResult.fallback || 'No changed files found in this pull request.',
      };
    }

    const files = filesResult.data;
    const changedFiles = files.filter(f => f.status !== 'unchanged');
    
    if (changedFiles.length === 0) {
      if (commentId) {
        await setReaction(octokit, owner, repo, commentId, REACTIONS.X);
      }
      return {
        success: false,
        error: 'No changed files found in this pull request.',
      };
    }

    logger.info({ totalFiles: changedFiles.length }, 'Fetching base and head versions for changed files');

    // Step 3: Fetch base and head versions for each file (up to MAX_COMPARE_FILES)
    const filesToCompare = changedFiles.slice(0, MAX_COMPARE_FILES);
    const filesData = [];

    for (const file of filesToCompare) {
      const { filename, status } = file;
      
      // Fetch base version (may be 404 for new files)
      let oldVersion = null;
      if (status !== 'added') {
        const baseResult = await fetchFileAtRef(octokit, owner, repo, filename, baseRef, { maxFileSize: MAX_FILE_CHARS });
        if (baseResult.success) {
          oldVersion = baseResult.data;
        } else if (baseResult.error?.status !== 404) {
          logger.warn({ filename, error: baseResult.error }, 'Failed to fetch base version');
        }
      }

      // Fetch head version (may be 404 for deleted files)
      let newVersion = null;
      if (status !== 'removed') {
        const headResult = await fetchFileAtRef(octokit, owner, repo, filename, headRef, { maxFileSize: MAX_FILE_CHARS });
        if (headResult.success) {
          newVersion = headResult.data;
        } else if (headResult.error?.status !== 404) {
          logger.warn({ filename, error: headResult.error }, 'Failed to fetch head version');
        }
      }

      filesData.push({
        filename,
        status,
        oldVersion,
        newVersion,
      });
    }

    // Step 4: Build the comparison prompt
    const prompt = buildComparePrompt(filesData, DEFAULT_MAX_CHARS, changedFiles.length);

    logger.info({ promptLength: prompt.length, filesCompared: filesData.length }, 'Calling Z.ai API');

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

    const response = formatCompareResponse(result.data);

    logger.info({ responseLength: response.length }, 'Compare command completed successfully');

    // Add success reaction if commentId available
    if (commentId) {
      await setReaction(octokit, owner, repo, commentId, REACTIONS.ROCKET);
    }

    return {
      success: true,
      response,
    };

  } catch (error) {
    logger.error({ error: error.message }, 'Unexpected error in compare command');
    
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
  handleCompareCommand,
  buildComparePrompt,
  formatCompareResponse,
  MAX_COMPARE_FILES,
  MAX_FILE_CHARS,
};
