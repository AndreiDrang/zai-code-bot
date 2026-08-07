/**
 * Heavy job handler registry for the heavy worker.
 * Legacy command handlers and durable storage-backed jobs live here.
 */

import { handleAskCommand } from './ask.js';
import { handleExplainCommand } from './explain.js';
import { handleDescribeCommand } from './describe.js';
import { handleReviewCommand } from './review.js';
import { handleImpactCommand } from './impact.js';
import { handlePrPreviewJob } from './pr-preview.js';

/**
 * @param {string} commandType
 * @returns {Function|null} handler(ctx) => Promise<Object>
 */
export function getHeavyHandler(commandType) {
  switch (commandType) {
    case 'ask':
      return handleAskCommand;
    case 'explain':
      return handleExplainCommand;
    case 'describe':
      return handleDescribeCommand;
    case 'review':
      return handleReviewCommand;
    case 'impact':
      return handleImpactCommand;
    case 'pr_preview':
      return handlePrPreviewJob;
    default:
      return null;
  }
}
