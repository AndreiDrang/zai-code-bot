/**
 * Light-command handler registry for the main worker.
 *
 * Only LIGHT commands live here. HEAVY commands (review, impact) are delegated
 * to the heavy worker and never touch this map.
 */

import { handleHelpCommand } from './help.js';
import { handleDescribeCommand } from './describe.js';

/**
 * @param {string} commandType
 * @returns {Function|null} handler(ctx) => Promise<Object>
 */
export function getLightHandler(commandType) {
  switch (commandType) {
    case 'help':
      return handleHelpCommand;
    case 'describe':
      return handleDescribeCommand;
    // ask / explain: TODO — add handlers/ask.js, handlers/explain.js
    default:
      return null;
  }
}
