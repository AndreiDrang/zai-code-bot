/**
 * Impact & Risk Analysis Command Handler
 * 
 * Performs impact and risk analysis on a Pull Request when user comments `/zai impact`.
 * 
 * Flow:
 * 1. Fetch PR context (title, description, changed files, diffs)
 * 2. Send to LLM with specialized system prompt
 * 3. Post LLM response as threaded comment
 * 4. Extract suggested labels from response
 * 5. Apply labels to the PR (best-effort, non-blocking)
 */

const { upsertComment, setReaction, REACTIONS } = require('../comments');
const { truncateContext, DEFAULT_MAX_CHARS } = require('../context');

// Marker for idempotent comment upsert
const IMPACT_MARKER = '<!-- ZAI_IMPACT_COMMAND -->';

// System prompt for impact analysis
const IMPACT_SYSTEM_PROMPT = `You are an expert Technical Lead and Security Auditor reviewing a Pull Request. Your task is to perform an Impact and Risk Analysis based on the provided code diff, file names, and PR description.

Evaluate the "blast radius" of these changes and warn human reviewers if specific parts of the code require rigorous manual inspection.

Categorize the overall risk of the PR into one of four levels:
- 🟢 Low Risk: Cosmetic changes, documentation, simple pure HTML markup updates, or isolated CSS/Tailwind utility class adjustments.
- 🟡 Medium Risk: Standard feature additions, isolated bug fixes, or non-critical UI/frontend logic changes.
- 🟠 High Risk: Changes to server-side routing, database schema/migrations (e.g., PostgreSQL), edge computing scripts (e.g., Cloudflare Workers), or core backend logic.
- 🔴 Critical Risk: Modifications to authentication/authorization (e.g., JWT middleware, session management), security policies, payment processing, or heavy structural architecture shifts.

Respond STRICTLY in the following Markdown format. Keep your analysis concise, objective, and directly related to the provided diff.

**Risk Level:** [Insert 🟢 Low / 🟡 Medium / 🟠 High / 🔴 Critical]

**Impact Summary:**
[1-2 sentences summarizing what areas of the application are affected by this PR. Be specific about the domains, e.g., "This PR modifies the user session middleware and updates the styling of the login page."]

**Critical Areas Touched:**
[Bullet list of the most sensitive files or logic blocks modified. If none, write "None detected." Example:]
* \`auth/middleware.py\`: Modified token validation logic (Requires careful review).
* \`db/migrations/004_add_users.sql\`: Modifies existing schema.

**Suggested Labels:**
[Provide a comma-separated list of 2-4 short labels that the bot could automatically apply to the PR, each wrapped in backticks, e.g., \`risk: high\`, \`area: auth\`, \`area: styles\`]`;

/**
 * Format changed files list for the prompt
 * @param {Array} changedFiles - Array of {filename, status, patch} objects
 * @returns {string} Formatted file list
 */
function formatChangedFiles(changedFiles) {
  if (!changedFiles || changedFiles.length === 0) {
    return 'No files changed';
  }

  return changedFiles.map(file => {
    const statusEmoji = {
      added: '➕',
      modified: '📝',
      removed: '➖',
      renamed: '📦'
    }[file.status] || '📄';
    
    let output = `${statusEmoji} \`${file.filename}\` (${file.status})`;
    
    // Include patch if available (truncated if too long)
    if (file.patch) {
      const patchLines = file.patch.split('\n');
      const maxPatchLines = 50;
      if (patchLines.length > maxPatchLines) {
        output += `\n\`\`\`diff\n${patchLines.slice(0, maxPatchLines).join('\n')}\n... [truncated, ${patchLines.length - maxPatchLines} more lines]\n\`\`\``;
      } else {
        output += `\n\`\`\`diff\n${file.patch}\n\`\`\``;
      }
    }
    
    return output;
  }).join('\n\n');
}

/**
 * Build the user prompt for impact analysis
 * @param {Object} pr - PR metadata {title, body}
 * @param {Array} changedFiles - Array of changed files
 * @param {number} maxChars - Maximum characters for context
 * @returns {Object} {prompt, truncated}
 */
function buildImpactPrompt(pr, changedFiles, maxChars = DEFAULT_MAX_CHARS) {
  const fileList = formatChangedFiles(changedFiles);
  
  const rawPrompt = `Please analyze this Pull Request for impact and risk assessment.

## PR Title
${pr.title || 'No title provided'}

## PR Description
${pr.body || 'No description provided'}

## Changed Files
${fileList}`;

  const { content, truncated } = truncateContext(rawPrompt, maxChars);
  
  return {
    prompt: content,
    truncated
  };
}

/**
 * Extract suggested labels from LLM response
 * Parses the "Suggested Labels:" section and extracts backticked labels
 * 
 * @param {string} response - LLM response text
 * @returns {Array<string>} Array of extracted label strings
 */
function extractSuggestedLabels(response) {
  if (!response || typeof response !== 'string') {
    return [];
  }

  // Find the "Suggested Labels:" section
  const labelsSectionMatch = response.match(/\*\*Suggested Labels:\*\*\s*([\s\S]*?)(?=\n\n|\n\*\*|$)/i);
  
  if (!labelsSectionMatch) {
    return [];
  }

  const labelsSection = labelsSectionMatch[1];
  
  // Extract all backticked labels
  const backtickRegex = /`([^`]+)`/g;
  const labels = [];
  let match = backtickRegex.exec(labelsSection);
  
  while (match !== null) {
    const label = match[1].trim();
    // Filter out empty, too long, or punctuation-only labels
    if (label && label.length > 0 && label.length <= 50 && !/^[,.\s]+$/.test(label)) {
      labels.push(label);
    }
    match = backtickRegex.exec(labelsSection);
  }

  // Fallback: try comma-separated if no backticks found
  if (labels.length === 0) {
    const commaSeparated = labelsSection
      .split(',')
      .map(s => s.trim().replace(/^`|`$/g, '')) // Remove surrounding backticks
      .filter(s => s.length > 0 && s.length <= 50 && !/^[,.\s]+$/.test(s));
    labels.push(...commaSeparated.slice(0, 5));
  }

  // Dedupe and limit
  return [...new Set(labels)].slice(0, 5);
}

/**
 * Apply labels to the PR (best-effort, non-blocking)
 * 
 * @param {Object} octokit - GitHub API client
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @param {number} issueNumber - PR number
 * @param {Array<string>} labels - Labels to apply
 * @param {Object} logger - Logger instance
 * @returns {Promise<boolean>} Success status
 */
async function applySuggestedLabels(octokit, owner, repo, issueNumber, labels, logger, deps = {}) {
  const {
    addLabels: _addLabels = (params) => octokit.rest.issues.addLabels(params),
  } = deps;
  
  if (!labels || labels.length === 0) {
    return true;
  }

  try {
    await _addLabels({
      owner,
      repo,
      issue_number: issueNumber,
      labels
    });
    
    logger.info({ labels, issueNumber }, 'Applied suggested labels to PR');
    return true;
  } catch (error) {
    // Log warning but don't fail the command
    logger.warn({ 
      error: error.message, 
      labels, 
      issueNumber 
    }, 'Failed to apply labels to PR (non-blocking)');
    return false;
  }
}

/**
 * Main handler for /zai impact command
 * 
 * @param {Object} context - Handler context from dispatchCommand
 * @param {Array} args - Command arguments (unused for impact)
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function handleImpactCommand(context, args, deps = {}) {
  const {
    upsertComment: _upsertComment = upsertComment,
    setReaction: _setReaction = setReaction,
    applySuggestedLabels: _applySuggestedLabels = applySuggestedLabels,
  } = deps;
  
  const { 
    octokit, 
    owner, 
    repo, 
    issueNumber, 
    commentId, 
    apiClient, 
    apiKey, 
    model, 
    logger,
    changedFiles,
    maxChars = DEFAULT_MAX_CHARS 
  } = context;

  try {
    // 1. Set thinking reaction to show command is processing
    await _setReaction(octokit, owner, repo, commentId, REACTIONS.THINKING);

    // 2. Fetch PR metadata (title, description)
    let prData;
    try {
      const prResponse = await octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: issueNumber
      });
      prData = {
        title: prResponse.data.title,
        body: prResponse.data.body
      };
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to fetch PR metadata');
      await _upsertComment(
        octokit, owner, repo, issueNumber,
        `## Z.ai Impact Analysis\n\n❌ Failed to fetch PR metadata: ${error.message}\n\n${IMPACT_MARKER}`,
        IMPACT_MARKER,
        { replyToId: commentId }
      );
      await _setReaction(octokit, owner, repo, commentId, REACTIONS.X);
      return { success: false, error: 'Failed to fetch PR metadata' };
    }

    // 3. Build prompt for LLM
    const { prompt, truncated } = buildImpactPrompt(prData, changedFiles, maxChars);

    logger.info({ 
      issueNumber, 
      truncated,
      filesCount: changedFiles?.length || 0 
    }, 'Built impact analysis prompt');

    // 4. Call LLM API
    const llmResult = await apiClient.call({ 
      apiKey, 
      model, 
      prompt: `System instructions:\n${IMPACT_SYSTEM_PROMPT}\n\n---\n\n${prompt}`
    });

    if (!llmResult.success) {
      logger.error({ error: llmResult.error }, 'LLM call failed for impact command');
      await _upsertComment(
        octokit, owner, repo, issueNumber,
        `## Z.ai Impact Analysis\n\n❌ Failed to analyze PR. Please try again later.\n\n${IMPACT_MARKER}`,
        IMPACT_MARKER,
        { replyToId: commentId }
      );
      await _setReaction(octokit, owner, repo, commentId, REACTIONS.X);
      return { success: false, error: llmResult.error };
    }

    const analysis = llmResult.data;

    // 5. Post analysis as comment
    const commentBody = `## Z.ai Impact & Risk Analysis\n\n${analysis}\n\n${IMPACT_MARKER}`;
    
    await _upsertComment(
      octokit, owner, repo, issueNumber,
      commentBody,
      IMPACT_MARKER,
      { replyToId: commentId }
    );

    // 6. Extract and apply suggested labels (best-effort, non-blocking)
    const suggestedLabels = extractSuggestedLabels(analysis);
    
    if (suggestedLabels.length > 0) {
      logger.info({ suggestedLabels, issueNumber }, 'Extracted suggested labels');
      await _applySuggestedLabels(octokit, owner, repo, issueNumber, suggestedLabels, logger);
    } else {
      logger.info({ issueNumber }, 'No suggested labels found in analysis');
    }

    // 7. Set success reaction
    await _setReaction(octokit, owner, repo, commentId, REACTIONS.ROCKET);

    return { success: true };

  } catch (error) {
    logger.error({ error: error.message, stack: error.stack }, 'Impact command failed unexpectedly');
    
    try {
      await _upsertComment(
        octokit, owner, repo, issueNumber,
        `## Z.ai Impact Analysis\n\n❌ An unexpected error occurred: ${error.message}\n\n${IMPACT_MARKER}`,
        IMPACT_MARKER,
        { replyToId: commentId }
      );
      await _setReaction(octokit, owner, repo, commentId, REACTIONS.X);
    } catch (commentError) {
      logger.error({ error: commentError.message }, 'Failed to post error comment');
    }
    
    return { success: false, error: error.message };
  }
}

module.exports = {
  handleImpactCommand,
  IMPACT_MARKER,
  buildImpactPrompt,
  extractSuggestedLabels,
  applySuggestedLabels,
  formatChangedFiles
};
