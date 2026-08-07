/**
 * Command parsing utilities for Z.ai Code Bot.
 *
 * Pure module — safe to import from both workers.
 */

import { COMMENT_MARKER, AVAILABLE_COMMANDS, BOT_FOOTER } from './constants.js';

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
 * Formats the help message.
 * @returns {string}
 */
export function formatHelp() {
  return `## 🤖 Z.ai Code Bot Help

Available commands:

### Code Review & Analysis
- \`/zai review\` — Request a full code review of the Pull Request *(heavy)*
- \`/zai explain <lines>\` — Explain specific lines of code (e.g. \`/zai explain 10-20\`) *(heavy)*
- \`/zai ask <question>\` — Ask a question about the code *(heavy)*
- \`/zai impact\` — Analyze the potential impact of changes *(heavy)*

### Documentation
- \`/zai describe\` — Generate PR description from commits *(heavy)*

### Help
- \`/zai help\` — Show this help message

### Usage Notes
- Example: \`/zai review\`
- For line-specific commands, specify line numbers or ranges
- *(heavy)* commands run on the dedicated heavy worker

---
${BOT_FOOTER}

${COMMENT_MARKER}`;
}

/**
 * Formats the "command not available" message.
 * @param {string} command
 * @returns {string}
 */
export function formatCommandNotAvailable(command) {
  return `## ⚠️ Command Not Available in POC

The command \`/zai ${command}\` is recognized but not yet implemented in this POC.

Currently functional:
- \`/zai help\` — Show help message

Other commands will be wired up as handlers are migrated.

---
${BOT_FOOTER}

${COMMENT_MARKER}`;
}
