/**
 * Help Command Handler
 * 
 * Handles `/zai help` command.
 * Returns deterministic help text with all available commands.
 */

const comments = require('../comments');
const auth = require('../auth');

const REACTION = 'eyes';

const HELP_TEXT = `## Available Commands

| Command | Usage | Description |
|---------|-------|-------------|
| \`/zai ask\` | \`/zai ask <question>\` | Ask a question about the code |
| \`/zai review\` | \`/zai review [file]\` | Review specific files |
| \`/zai explain\` | \`/zai explain <lines>\` | Explain selected lines |
| \`/zai suggest\` | \`/zai suggest <prompt>\` | Suggest improvements |
| \`/zai compare\` | \`/zai compare\` | Compare old vs new version |
| \`/zai help\` | \`/zai help\` | Show this help message |

**Note:** Only collaborators can use these commands.`;

const HELP_MARKER = '<!-- ZAI-HELP-RESPONSE -->';

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

  if (commentId) {
    await comments.setReaction(octokit, owner, repo, commentId, REACTION);
  }

  const commentResult = await comments.upsertComment(
    octokit,
    owner,
    repo,
    issueNumber,
    HELP_TEXT + '\n\n' + HELP_MARKER,
    HELP_MARKER,
    { replyToId: commentId, updateExisting: false }
  );

  if (commentResult.action === 'created' || commentResult.action === 'updated') {
    logger.info({ command: 'help' }, 'Help command completed successfully');
    return { success: true };
  }

  return { success: false, error: 'Failed to post help response' };
}

module.exports = {
  handleHelpCommand,
  HELP_TEXT,
  HELP_MARKER,
};
