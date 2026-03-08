/**
 * Help Command Handler
 * 
 * Handles `/zai help` command.
 * Returns deterministic help text with all available commands.
 */

const comments = require('../comments');
const auth = require('../auth');
const { COMMAND_DESCRIPTIONS } = require('../commands');

const { REACTIONS, setReaction } = require('../comments');

const HELP_MARKER = '<!-- ZAI-HELP-RESPONSE -->';

/**
 * Build help text from COMMAND_DESCRIPTIONS
 * @returns {string} Formatted help text
 */
function buildHelpText() {
  const rows = Object.entries(COMMAND_DESCRIPTIONS).map(([name, { usage, description }]) => {
    return `| \`/zai ${name}\` | \`${usage}\` | ${description} |`;
  }).join('\n');

  return `## Available Commands

| Command | Usage | Description |
|---------|-------|-------------|
${rows}

**Note:** Only collaborators can use these commands.`;
}

/**
 * Handle the help command
 * @param {Object} params - Handler parameters
 * @param {Object} params.octokit - GitHub Octokit instance
 * @param {Object} params.context - GitHub context object
 * @param {Object} params.commenter - Commenter object with login property
 * @param {string[]} params.args - Command arguments
 * @param {Object} params.logger - Logger instance
 * @returns {Promise<{ success: boolean, message?: string, error?: string }>}
 */
async function handleHelpCommand({ octokit, context: githubContext, commenter, args, logger }) {
  const { owner, repo } = githubContext.repo;
  const issueNumber = githubContext.payload.pull_request.number;
  const commentId = githubContext.payload.comment?.id;

  const authResult = await auth.checkForkAuthorization(octokit, githubContext, commenter);
  if (!authResult.authorized) {
    if (authResult.reason) {
      return { success: false, error: authResult.reason };
    }
    return { success: false, error: null };
  }

  // Add acknowledgment reaction
  if (commentId) {
    await setReaction(octokit, owner, repo, commentId, REACTIONS.EYES);
  }

  const commentResult = await comments.upsertComment(
    octokit,
    owner,
    repo,
    issueNumber,
    buildHelpText() + '\n\n' + HELP_MARKER,
    HELP_MARKER,
    { replyToId: commentId, updateExisting: false }
  );

  if (commentResult.action === 'created' || commentResult.action === 'updated') {
    // Add success reaction
    if (commentId) {
      await setReaction(octokit, owner, repo, commentId, REACTIONS.ROCKET);
    }
    
    logger.info({ command: 'help' }, 'Help command completed successfully');
    return { success: true };
  }

  // Add error reaction for failed comment post
  if (commentId) {
    await setReaction(octokit, owner, repo, commentId, REACTIONS.X);
  }
  
  return { success: false, error: 'Failed to post help response' };
}

module.exports = {
  handleHelpCommand,
  buildHelpText,
  HELP_TEXT: buildHelpText(),
  HELP_MARKER,
};
