/**
 * Constants for Z.ai Code Bot POC
 */

// Comment markers
export const COMMENT_MARKER = '<!-- zai-code-review -->';
export const PROGRESS_MARKER = '<!-- zai-progress -->';

// Command types
export const COMMANDS = {
  HELP: 'help',
  ASK: 'ask',
  REVIEW: 'review',
  EXPLAIN: 'explain',
  DESCRIBE: 'describe',
  IMPACT: 'impact'
};

// Event types
export const EVENT_TYPES = {
  PULL_REQUEST_OPENED: 'pull_request_opened',
  PULL_REQUEST_SYNC: 'pull_request_synchronize',
  ISSUE_COMMENT: 'issue_comment',
  PR_COMMENT: 'pull_request_comment',
  PR_REVIEW_COMMENT: 'pull_request_review_comment'
};

// Default configuration
export const DEFAULT_CONFIG = {
  zaiModel: 'glm-5.2',
  timeout: 30000,
  maxRetries: 3
};

// Error messages
export const ERROR_MESSAGES = {
  UNAUTHORIZED: 'You do not have permission to run this command.',
  UNKNOWN_COMMAND: 'Unknown command. Use /zai help to see available commands.',
  INTERNAL_ERROR: 'An internal error occurred. Please try again later.',
  POC_LIMITATION: 'This command is not available in the POC version. Only /zai help is supported.'
};

// Success messages
export const SUCCESS_MESSAGES = {
  HELP_POSTED: 'Help message posted successfully!'
};
