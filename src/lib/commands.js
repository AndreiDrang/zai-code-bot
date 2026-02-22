/**
 * Z.ai Command Parser
 * 
 * Parses `/zai` commands and `@zai-bot` mentions into structured output.
 * Enforces allowlist of valid commands.
 */

// Allowlisted commands
const ALLOWED_COMMANDS = ['ask', 'review', 'explain', 'suggest', 'compare', 'help'];

// Error types
const ERROR_TYPES = {
  UNKNOWN_COMMAND: 'unknown_command',
  MALFORMED_INPUT: 'malformed_input',
  EMPTY_INPUT: 'empty_input',
};

/**
 * Normalize input: convert @zai-bot mentions to /zai format
 * @param {string} input - Raw input string
 * @returns {string} - Normalized input
 */
function normalizeInput(input) {
  if (typeof input !== 'string') {
    return '';
  }
  
  // Trim whitespace
  let normalized = input.trim();
  
  // Convert @zai-bot to /zai (case-insensitive mention normalization)
  // Matches: @zai-bot, @zaibot, @zai, etc. at start of input
  normalized = normalized.replace(/^@zai[-_]?bot\s+/i, '/zai ');
  
  // Also handle @zai without -bot suffix
  normalized = normalized.replace(/^@zai\s+/i, '/zai ');
  
  return normalized;
}

/**
 * Parse a /zai command string into structured output
 * @param {string} input - Raw input string (e.g., "/zai ask what is this?")
 * @returns {Object} - Parsed result: { command, args, raw, error? }
 */
function parseCommand(input) {
  const raw = input;
  
  // Handle null/undefined/empty input
  if (input === null || input === undefined || input === '') {
    return {
      command: null,
      args: [],
      raw,
      error: { type: ERROR_TYPES.EMPTY_INPUT, message: 'Input is empty' },
    };
  }
  
  // Normalize the input (handle mentions)
  const normalized = normalizeInput(input);
  
  // Check if it starts with /zai (case-insensitive)
  if (!normalized.toLowerCase().startsWith('/zai')) {
    // If normalized input is empty after processing, it's empty input
    if (!normalized) {
      return {
        command: null,
        args: [],
        raw,
        error: { type: ERROR_TYPES.EMPTY_INPUT, message: 'Input is empty' },
      };
    }
    return {
      command: null,
      args: [],
      raw,
      error: { type: ERROR_TYPES.MALFORMED_INPUT, message: 'Input must start with /zai' },
    };
  }
  
  // Extract command and args after /zai (normalize prefix to lowercase)
  const afterZai = normalized.slice(4).trim();
  
  // If nothing after /zai, it's malformed
  if (!afterZai) {
    return {
      command: null,
      args: [],
      raw,
      error: { type: ERROR_TYPES.MALFORMED_INPUT, message: 'Missing command after /zai' },
    };
  }
  
  // Parse command and args (split by whitespace)
  const parts = afterZai.split(/\s+/);
  const command = parts[0].toLowerCase();
  const args = parts.slice(1);
  
  // Check if command is in allowlist
  if (!ALLOWED_COMMANDS.includes(command)) {
    return {
      command: null,
      args: [],
      raw,
      error: { type: ERROR_TYPES.UNKNOWN_COMMAND, message: `Unknown command: ${command}` },
    };
  }
  
  // Valid command
  return {
    command,
    args,
    raw,
    error: null,
  };
}

/**
 * Check if a parsed result is valid (has no error)
 * @param {Object} result - Result from parseCommand
 * @returns {boolean}
 */
function isValid(result) {
  return result.error === null;
}

module.exports = {
  ALLOWED_COMMANDS,
  ERROR_TYPES,
  parseCommand,
  normalizeInput,
  isValid,
};
