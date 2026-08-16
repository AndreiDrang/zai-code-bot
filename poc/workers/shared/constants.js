/**
 * Shared constants for Z.ai Code Bot (Cloudflare Workers).
 *
 * Imported by BOTH zai-main-worker and zai-heavy-worker via relative path:
 *   import { ... } from '../../shared/constants.js'
 */

// ---------------------------------------------------------------------------
// Comment markers (idempotency / lookup).
// ---------------------------------------------------------------------------
export const COMMENT_MARKER = '<!-- zai-code-review -->';
export const REVIEW_MARKER = '<!-- zai-review -->';
export const DESCRIBE_MARKER = '<!-- zai-describe -->';
export const PROGRESS_MARKER = '<!-- zai-progress -->';

// ---------------------------------------------------------------------------
// Command classification — single source of truth for help, light, and heavy
// routing. Reclassify a command by moving it between these sets.
// ---------------------------------------------------------------------------
// Help is handled inline by the main Worker. The two LLM commands run
// asynchronously on the Queue consumer. Keeping this list intentionally small
// prevents accidental command-surface expansion during the Workers migration.
export const HELP_COMMANDS = ['help'];
export const LIGHT_COMMANDS = [];
export const HEAVY_COMMANDS = ['review', 'describe'];

// Full allowlist (union of help + light + heavy). Anything else is
// "unsupported".
export const AVAILABLE_COMMANDS = [...HELP_COMMANDS, ...LIGHT_COMMANDS, ...HEAVY_COMMANDS];

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------
export const EVENT_TYPES = {
  PULL_REQUEST_OPENED: 'pull_request_opened',
  PULL_REQUEST_SYNC: 'pull_request_synchronize',
  ISSUE_COMMENT: 'issue_comment',
  PR_COMMENT: 'pull_request_comment',
  PR_REVIEW_COMMENT: 'pull_request_review_comment',
};

// ---------------------------------------------------------------------------
// Default configuration
// ---------------------------------------------------------------------------
export const DEFAULT_CONFIG = {
  zaiModel: 'glm-5.2',
  timeout: 30000,
  maxRetries: 3,
};

// ---------------------------------------------------------------------------
// Shared footer — identical across every bot comment.
// ---------------------------------------------------------------------------
export const BOT_FOOTER =
  '*Powered by [AndreiDrang](https://github.com/AndreiDrang), [Z.ai](https://z.ai) and [Cloudflare Workers](https://cloudflare.com)*';
export const HELP_MARKER = '<!-- zai-help -->';

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------
export const ERROR_MESSAGES = {
  UNAUTHORIZED: 'You do not have permission to run this command.',
  UNKNOWN_COMMAND:
    'Unknown command. Supported commands are /zai help, /zai review, and /zai describe.',
  INTERNAL_ERROR: 'An internal error occurred. Please try again later.',
};
