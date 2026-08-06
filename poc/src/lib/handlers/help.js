/**
 * Handler for /zai help command
 * This is the main handler for the POC
 */

import { formatHelp, formatCommandNotAvailable } from '../commands.js';
import { COMMENT_MARKER, ERROR_MESSAGES, SUCCESS_MESSAGES } from '../../config/constants.js';

/**
 * Handles the help command
 * @param {Object} context - Execution context
 * @param {GitHubClient} context.github - GitHub API client
 * @param {Object} context.event - Event data
 * @returns {Promise<Object>} - Result object
 */
export async function handleHelpCommand(context) {
  const { github, event } = context;
  const { repository, issue, comment } = event;
  
  try {
    // Format help message
    const response = formatHelp();
    
    // Post comment to GitHub
    await github.postComment(
      repository.owner.login,
      repository.name,
      issue.number,
      response
    );
    
    return {
      status: 'success',
      action: 'help',
      message: SUCCESS_MESSAGES.HELP_POSTED,
      repository: repository.full_name,
      issue: issue.number,
      user: comment.user.login
    };
  } catch (error) {
    console.error('Error handling help command:', error);
    
    // Post error comment
    await github.postComment(
      repository.owner.login,
      repository.name,
      issue.number,
      `## ❌ Error Processing /zai help

An error occurred while processing your command:

\`\`\`
${error.message}
\`\`\`

Please try again later.

${COMMENT_MARKER}`
    );
    
    return {
      status: 'error',
      action: 'help',
      error: error.message,
      repository: repository?.full_name,
      issue: issue?.number
    };
  }
}

/**
 * Handles unsupported commands (for POC)
 * @param {Object} context - Execution context
 * @returns {Promise<Object>} - Result object
 */
export async function handleUnsupportedCommand(context) {
  const { github, event } = context;
  const { repository, issue, comment } = event;
  
  try {
    // Get the command that was attempted
    const command = comment.body.split(' ')[1] || comment.body;
    
    // Format response
    const response = formatCommandNotAvailable(command);
    
    // Post comment to GitHub
    await github.postComment(
      repository.owner.login,
      repository.name,
      issue.number,
      response
    );
    
    return {
      status: 'success',
      action: 'unsupported',
      message: 'Command not available message posted',
      command: command,
      repository: repository.full_name,
      issue: issue.number
    };
  } catch (error) {
    console.error('Error handling unsupported command:', error);
    
    return {
      status: 'error',
      action: 'unsupported',
      error: error.message
    };
  }
}

/**
 * Checks if this handler can process the command
 * @param {string} commandType - Command type
 * @returns {boolean} - Whether handler can process
 */
export function canHandle(commandType) {
  return commandType === 'help';
}

/**
 * Handler metadata
 */
export const handlerMetadata = {
  name: 'help',
  description: 'Show help message with available commands',
  requiresRepo: false,
  requiresCodeAccess: false,
  rateLimit: {
    max: 10,
    window: 60000  // 10 requests per minute
  }
};
