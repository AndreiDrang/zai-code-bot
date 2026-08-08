/**
 * Handler for /zai help — a LIGHT command run inline on the main worker.
 */

import { formatHelp } from '../../../shared/commands.js';
import { COMMENT_MARKER, SUCCESS_MESSAGES, BOT_FOOTER } from '../../../shared/constants.js';
import { createLogger } from '../../../shared/logging.js';

/**
 * @param {Object} ctx
 * @param {import('../../../shared/github.js').GitHubClient} ctx.github
 * @param {Object} ctx.event - { repository, issue, comment }
 * @returns {Promise<Object>}
 */
export async function handleHelpCommand({ github, event }) {
  const { repository, issue, comment } = event;

  try {
    await github.postComment(repository.owner.login, repository.name, issue.number, formatHelp());
    return {
      status: 'success',
      action: 'help',
      message: SUCCESS_MESSAGES.HELP_POSTED,
      repository: repository.full_name,
      issue: issue.number,
      user: comment.user.login,
    };
  } catch (error) {
    await postErrorComment(github, repository, issue, error);
    return { status: 'error', action: 'help', error: error.message };
  }
}

async function postErrorComment(github, repository, issue, error) {
  // Log the real error for observability, but post only a sanitized message
  // (never leak exception internals into a PR comment).
  createLogger({}, 'zai-main-worker:help').error('help command failed', {
    message: error?.message,
  });
  try {
    await github.postComment(
      repository.owner.login,
      repository.name,
      issue.number,
      `## ❌ Error Processing /zai help\n\nPlease try again later.\n\n---\n${BOT_FOOTER}\n\n${COMMENT_MARKER}`,
    );
  } catch {
    /* best-effort; nothing else we can do */
  }
}

/** Whether this handler can process the command. */
export function canHandle(commandType) {
  return commandType === 'help';
}
