/**
 * Handler for /zai ask — a HEAVY command (free-form question -> LLM call).
 *
 * STUB: posts a placeholder notice. When implemented, mirrors the parent bot's
 * ask handler: build repository context, send the question + context to the
 * Z.ai API, post the response as a threaded comment.
 *
 * Heavy handlers own their own GitHub I/O (they run after main has acked).
 */

import { COMMENT_MARKER, BOT_FOOTER } from '../../../shared/constants.js';
import { createLogger } from '../../../shared/logging.js';

/**
 * @param {Object} ctx
 * @param {import('../../shared/github.js').GitHubClient} ctx.github
 * @param {Object} ctx.payload - delegation payload from the main worker
 */
export async function handleAskCommand({ github, payload }) {
  const logger = createLogger({ NODE_ENV: 'production' }, 'zai-heavy-worker:ask');
  const { repository, issue } = payload;

  logger.info('ask stub', {
    repo: repository?.full_name,
    issue: issue?.number,
  });

  await github.postComment(
    repository.owner,
    repository.name,
    issue.number,
    `## 💬 /zai ask\n\nYour question is queued on the heavy worker. (POC stub — full implementation pending.)\n\n---\n${BOT_FOOTER}\n\n${COMMENT_MARKER}`,
  );

  return {
    status: 'stub',
    action: 'ask',
    repository: repository?.full_name,
    issue: issue?.number,
  };
}

export function canHandle(commandType) {
  return commandType === 'ask';
}
