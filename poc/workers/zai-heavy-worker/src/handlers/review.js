/**
 * Handler for /zai review — a HEAVY command (large diff → long LLM call).
 *
 * STUB: posts a "queued / not yet implemented" notice. When migrated from the
 * parent bot (see ../../../zai-heavy-worker notes + ../src/lib/handlers/review.js
 * in repo root), this handler will:
 *   1. fetch PR changed files via shared GitHubClient.getPrFiles (paginated)
 *   2. build a review prompt bounded by code-scope rules
 *   3. call the Z.ai API with retry/backoff
 *   4. post the review as a threaded, marker-idempotent comment
 * Heavy handlers MUST own their own GitHub I/O (they run after main has acked).
 */

import { COMMENT_MARKER, BOT_FOOTER } from '../../../shared/constants.js';
import { createLogger } from '../../../shared/logging.js';

/**
 * @param {Object} ctx
 * @param {import('../../shared/github.js').GitHubClient} ctx.github
 * @param {Object} ctx.payload - delegation payload from the main worker
 */
export async function handleReviewCommand({ github, payload }) {
  const logger = createLogger({ NODE_ENV: 'production' }, 'zai-heavy-worker:review');
  const { repository, issue } = payload;

  logger.info('review stub', {
    repo: repository?.full_name,
    issue: issue?.number,
  });

  await github.postComment(
    repository.owner,
    repository.name,
    issue.number,
    `## 🔍 /zai review\n\nReview pipeline is queued on the heavy worker. (POC stub — full implementation pending.)\n\n---\n${BOT_FOOTER}\n\n${COMMENT_MARKER}`,
  );

  return {
    status: 'stub',
    action: 'review',
    repository: repository?.full_name,
    issue: issue?.number,
  };
}

export function canHandle(commandType) {
  return commandType === 'review';
}
