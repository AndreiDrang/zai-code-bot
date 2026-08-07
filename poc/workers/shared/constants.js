/**
 * Shared constants for Z.ai Code Bot (hybrid Workers).
 *
 * Imported by BOTH zai-main-worker and zai-heavy-worker via relative path:
 *   import { ... } from '../../shared/constants.js'
 */

// ---------------------------------------------------------------------------
// Comment markers (idempotency / lookup) — keep in sync with parent bot.
// ---------------------------------------------------------------------------
export const COMMENT_MARKER = '<!-- zai-code-review -->';
export const PR_PREVIEW_MARKER = '<!-- zai-pr-preview -->';
export const REVIEW_MARKER = '<!-- zai-review -->';
export const IMPACT_MARKER = '<!-- zai-impact -->';
export const PROGRESS_MARKER = '<!-- zai-progress -->';

// ---------------------------------------------------------------------------
// Command classification — single source of truth for light vs heavy routing.
// Reclassify a command by moving it between these two sets.
// ---------------------------------------------------------------------------
// LIGHT = completes inline within the webhook (~10s budget), NO LLM call.
// HEAVY = makes a Z.ai LLM call (or heavy I/O); must run async on the heavy worker.
export const LIGHT_COMMANDS = ['help'];
export const HEAVY_COMMANDS = ['ask', 'explain', 'describe', 'review', 'impact'];

// Full allowlist (union of light + heavy). Anything else is "unsupported".
export const AVAILABLE_COMMANDS = [...LIGHT_COMMANDS, ...HEAVY_COMMANDS];

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
// Internal Worker-to-Worker delegation protocol
// ---------------------------------------------------------------------------
export const INTERNAL_TOKEN_HEADER = 'x-zai-internal-token';
export const INTERNAL_PATH = '/handle';

// ---------------------------------------------------------------------------
// Default configuration
// ---------------------------------------------------------------------------
export const DEFAULT_CONFIG = {
  zaiModel: 'glm-5.2',
  timeout: 30000,
  maxRetries: 3,
};

// ---------------------------------------------------------------------------
// Shared footer — identical across EVERY bot comment. Append before the
// hidden marker so the rendered attribution is uniform help, previews,
// reviews, errors, and stubs alike.
// ---------------------------------------------------------------------------
export const BOT_FOOTER =
  '*Powered by [AndreiDrang](https://github.com/AndreiDrang), [Z.ai](https://z.ai) and [Cloudflare Workers](https://cloudflare.com)*';

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------
export const ERROR_MESSAGES = {
  UNAUTHORIZED: 'You do not have permission to run this command.',
  UNKNOWN_COMMAND: 'Unknown command. Use /zai help to see available commands.',
  INTERNAL_ERROR: 'An internal error occurred. Please try again later.',
  POC_LIMITATION: 'This command is not available in the POC version. Only /zai help is supported.',
};

export const SUCCESS_MESSAGES = {
  HELP_POSTED: 'Help message posted successfully!',
};
