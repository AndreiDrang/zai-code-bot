/**
 * Handler for /zai ask — a HEAVY command (free-form question -> LLM call).
 *
 * Context-aware stub: reads the gathered PR shape from the KV pr-card (no
 * getPullRequest) so the queued notice carries the PR identity it will be
 * answered against. The LLM call lands with the ask feature.
 */

import { COMMENT_MARKER, BOT_FOOTER } from '../../../shared/constants.js';
import { createLogger } from '../../../shared/logging.js';
import { readPrCard, renderPrCardShape } from '../../../shared/pr-context-reader.js';

/**
 * @param {Object} ctx
 * @param {import('../../shared/github.js').GitHubClient} ctx.github
 * @param {Object} ctx.env
 * @param {Object} ctx.payload - delegation payload from the main worker
 */
export async function handleAskCommand({ github, env, payload }) {
  const logger = createLogger(env, 'zai-heavy-worker:ask');
  const { repository, issue, prNumber } = payload;

  const card = await readPrCard(env.BOT_CACHE, repository?.id, prNumber);
  const shape = renderPrCardShape(card);
  const note = shape
    ? `${shape}\n\nYour question is queued on the heavy worker. (POC stub — full implementation pending.)`
    : 'Your question is queued on the heavy worker. (POC stub — full implementation pending.)';

  logger.info('ask context-aware stub', {
    repo: repository?.full_name,
    issue: issue?.number,
    headSha: card?.headSha ?? null,
  });

  await github.postComment(
    repository.owner,
    repository.name,
    issue.number,
    `## 💬 /zai ask\n\n${note}\n\n---\n${BOT_FOOTER}\n\n${COMMENT_MARKER}`,
  );

  return {
    status: 'stub',
    action: 'ask',
    repository: repository?.full_name,
    issue: issue?.number,
    headSha: card?.headSha ?? null,
  };
}

export function canHandle(commandType) {
  return commandType === 'ask';
}
