/**
 * Command parsing utilities for Z.ai Code Bot.
 *
 * Pure module — safe to import from both workers.
 */

import { AVAILABLE_COMMANDS, BOT_FOOTER, COMMENT_MARKER, HELP_MARKER } from './constants.js';

// Invocation form: /zai only. The @zai-bot mention and /zai-bot slash forms
// were removed — callers must invoke the bot with "/zai <command>".
const COMMAND_REGEX = /^\/zai\s+([a-zA-Z0-9_-]+)(?:\s+([\s\S]*))?$/;

/**
 * Parses a command from comment text.
 * @param {string} text
 * @returns {{type:string,args:string,raw:string,isValid:boolean}|null}
 */
export function parseCommand(text) {
  if (!text || typeof text !== 'string') return null;

  const trimmed = text.trim();

  const match = trimmed.match(COMMAND_REGEX);
  if (match) {
    const type = match[1].toLowerCase();
    return {
      type,
      args: (match[2] || '').trim(),
      raw: trimmed,
      isValid: AVAILABLE_COMMANDS.includes(type),
    };
  }

  return null;
}

/**
 * Checks if text contains a recognizable /zai command.
 * @param {string} text
 * @returns {boolean}
 */
export function isCommand(text) {
  return parseCommand(text) !== null;
}

/**
 * @returns {string[]} full command allowlist
 */
export function getAvailableCommands() {
  return [...AVAILABLE_COMMANDS];
}

/**
 * Formats the command list shown by `/zai help`.
 * @returns {string}
 */
export function formatHelp() {
  return `## 🤖 Z.ai Code Bot

Supported commands:

- \`/zai help\` — show this command list.
- \`/zai review\` — run a full-context pull-request review.
- \`/zai describe\` — generate and update the pull-request description.

The review and describe commands run asynchronously through Cloudflare Workers.

---
${BOT_FOOTER}

${HELP_MARKER}`;
}

/**
 * Formats the "command not available" message.
 * @param {string} command
 * @returns {string}
 */
export function formatCommandNotAvailable(command) {
  return `## ⚠️ Unknown Command

\`/zai ${command}\` isn't a recognized command.

Supported commands: \`/zai help\`, \`/zai review\`, and \`/zai describe\`.

---
${BOT_FOOTER}

${COMMENT_MARKER}`;
}
