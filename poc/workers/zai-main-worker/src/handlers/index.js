/**
 * Light-command handler registry for the main worker.
 *
 * Only LIGHT commands live here — the ones that need NO LLM call and finish
 * inside GitHub's ~10s webhook window. All LLM-backed commands (ask, explain,
 * describe, review, impact) are HEAVY and delegated to the heavy worker.
 */

import { handleHelpCommand } from './help.js';

/**
 * @param {string} commandType
 * @returns {Function|null} handler(ctx) => Promise<Object>
 */
export function getLightHandler(commandType) {
  switch (commandType) {
    case 'help':
      return handleHelpCommand;
    default:
      return null;
  }
}
