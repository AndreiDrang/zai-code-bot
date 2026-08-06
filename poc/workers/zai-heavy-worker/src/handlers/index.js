/**
 * Heavy-command handler registry for the heavy worker.
 * Only HEAVY commands live here (review, impact).
 */

import { handleReviewCommand } from './review.js';
import { handleImpactCommand } from './impact.js';

/**
 * @param {string} commandType
 * @returns {Function|null} handler(ctx) => Promise<Object>
 */
export function getHeavyHandler(commandType) {
  switch (commandType) {
    case 'review':
      return handleReviewCommand;
    case 'impact':
      return handleImpactCommand;
    default:
      return null;
  }
}
