/**
 * Command parsing utilities for Z.ai Code Bot
 */

import { COMMENT_MARKER } from '../config/constants.js';

// Regular expressions for command parsing
const COMMAND_REGEX = /^\/(zai|zai-bot)\s+([a-zA-Z0-9_-]+)(?:\s+(.*))?$/;
const MENTION_REGEX = /^@zai-bot\s+([a-zA-Z0-9_-]+)(?:\s+(.*))?$/;

// List of available commands
const AVAILABLE_COMMANDS = ['help', 'ask', 'review', 'explain', 'describe', 'impact'];

/**
 * Parses a command from comment text
 * @param {string} text - Comment text
 * @returns {Object|null} - Command object or null
 */
export function parseCommand(text) {
  if (!text || typeof text !== 'string') {
    return null;
  }
  
  const trimmed = text.trim();
  
  // Try parsing via /zai
  let match = trimmed.match(COMMAND_REGEX);
  if (match) {
    return {
      type: match[2].toLowerCase(),
      args: match[3] || '',
      raw: trimmed,
      isValid: AVAILABLE_COMMANDS.includes(match[2].toLowerCase())
    };
  }
  
  // Try parsing via @zai-bot
  match = trimmed.match(MENTION_REGEX);
  if (match) {
    return {
      type: match[1].toLowerCase(),
      args: match[2] || '',
      raw: trimmed,
      isValid: AVAILABLE_COMMANDS.includes(match[1].toLowerCase())
    };
  }
  
  return null;
}

/**
 * Checks if text contains a valid command
 * @param {string} text - Comment text
 * @returns {boolean} - Whether text is a command
 */
export function isCommand(text) {
  return parseCommand(text) !== null;
}

/**
 * Gets list of all available commands
 * @returns {string[]} - Array of command names
 */
export function getAvailableCommands() {
  return AVAILABLE_COMMANDS;
}

/**
 * Formats help message
 * @returns {string} - Formatted help text
 */
export function formatHelp() {
  return `## 🤖 Z.ai Code Bot Help

Available commands:

### Code Review & Analysis
- \`/zai review\` - Request a full code review of the Pull Request
- \`/zai explain <lines>\` - Explain specific lines of code (e.g., \`/zai explain 10-20\`)
- \`/zai ask <question>\` - Ask a question about the code
- \`/zai impact\` - Analyze the potential impact of changes

### Documentation
- \`/zai describe\` - Generate PR description from commits

### Help
- \`/zai help\` - Show this help message

### Usage Notes
- Commands can be triggered with \`/zai\` or @zai-bot
- Example: \`/zai review\` or @zai-bot review
- For line-specific commands, specify line numbers or ranges

---
*This is a Proof-of-Concept version. Only \`/zai help\` is currently functional.*

*Powered by [Z.ai](https://z.ai) and [Cloudflare Computer](https://cloudflare.com)*

${COMMENT_MARKER}`;
}

/**
 * Formats command not available message (for POC)
 * @param {string} command - Command that was requested
 * @returns {string} - Formatted message
 */
export function formatCommandNotAvailable(command) {
  return `## ⚠️ Command Not Available in POC

The command \`/zai ${command}\` is not available in this proof-of-concept version.

Currently supported commands:
- \`/zai help\` - Show help message

Other commands will be available after full migration.

${COMMENT_MARKER}`;
}
