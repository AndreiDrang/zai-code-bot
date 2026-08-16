/**
 * Command router for the main worker.
 *
 * Single source of truth for command classification. Both supported commands
 * are durable LLM jobs handled by the queue consumer.
 */

import {
  HELP_COMMANDS,
  LIGHT_COMMANDS,
  HEAVY_COMMANDS,
  AVAILABLE_COMMANDS,
} from '../../shared/constants.js';

/** @typedef {'help'|'light'|'heavy'|'unsupported'} RouteBucket */

/**
 * @param {string} commandType
 * @returns {RouteBucket}
 */
export function classifyCommand(commandType) {
  if (HELP_COMMANDS.includes(commandType)) return 'help';
  if (LIGHT_COMMANDS.includes(commandType)) return 'light';
  if (HEAVY_COMMANDS.includes(commandType)) return 'heavy';
  return 'unsupported';
}

/**
 * @returns {string[]} every recognized command (light + heavy)
 */
export function getAllCommands() {
  return [...AVAILABLE_COMMANDS];
}
