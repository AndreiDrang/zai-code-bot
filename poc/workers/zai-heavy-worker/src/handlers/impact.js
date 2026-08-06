/**
 * Handler for /zai impact — a HEAVY command (impact/risk analysis → LLM).
 *
 * STUB: posts a placeholder notice. When migrated, mirrors the parent bot's
 * impact handler: fetch PR context, send specialized risk-analysis prompt,
 * post result, and best-effort apply suggested labels.
 */

import { COMMENT_MARKER } from '../../../shared/constants.js';
import { createLogger } from '../../../shared/logging.js';

/**
 * @param {Object} ctx
 * @param {import('../../shared/github.js').GitHubClient} ctx.github
 * @param {Object} ctx.payload
 */
export async function handleImpactCommand({ github, payload }) {
  const logger = createLogger({ NODE_ENV: 'production' }, 'zai-heavy-worker:impact');
  const { repository, issue } = payload;

  logger.info('impact stub', {
    repo: repository?.full_name,
    issue: issue?.number,
  });

  await github.postComment(
    repository.owner,
    repository.name,
    issue.number,
    `## 📊 /zai impact\n\nImpact & risk analysis is queued on the heavy worker. (POC stub — full implementation pending.)\n\n${COMMENT_MARKER}`,
  );

  return {
    status: 'stub',
    action: 'impact',
    repository: repository?.full_name,
    issue: issue?.number,
  };
}

export function canHandle(commandType) {
  return commandType === 'impact';
}
