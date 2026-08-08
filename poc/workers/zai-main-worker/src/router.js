/**
 * Command router for the main worker.
 *
 * Single source of truth for light-vs-heavy classification. The main worker
 * handles LIGHT commands inline; HEAVY commands are delegated to the heavy
 * worker. Reclassify a command by editing `ROUTE` below.
 */

import { LIGHT_COMMANDS, HEAVY_COMMANDS, AVAILABLE_COMMANDS } from '../../shared/constants.js';

/** @typedef {'light'|'heavy'|'unsupported'} RouteBucket */

/**
 * @param {string} commandType
 * @returns {RouteBucket}
 */
export function classifyCommand(commandType) {
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
