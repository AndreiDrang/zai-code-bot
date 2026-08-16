/**
 * Durable job handler registry for the heavy worker.
 */

import { handleDescribeCommand } from './describe.js';
import { handleReviewCommand } from './review.js';
import { handlePrContextJob } from './pr-context.js';

/**
 * @param {string} commandType
 * @returns {Function|null} handler(ctx) => Promise<Object>
 */
export function getHeavyHandler(commandType) {
  switch (commandType) {
    case 'describe':
      return handleDescribeCommand;
    case 'review':
      return handleReviewCommand;
    case 'pr_context':
      return handlePrContextJob;
    default:
      return null;
  }
}
