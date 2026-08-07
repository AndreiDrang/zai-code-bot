/**
 * Handler for /zai explain — a HEAVY command (line range -> LLM explanation).
 *
 * STUB: posts a placeholder notice. When implemented, mirrors the parent bot's
 * explain handler: extract the requested line range, fetch surrounding code
 * scope, send to the Z.ai API, post the explanation as a threaded comment.
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
export async function handleExplainCommand({ github, payload }) {
  const logger = createLogger({ NODE_ENV: 'production' }, 'zai-heavy-worker:explain');
  const { repository, issue } = payload;

  logger.info('explain stub', {
    repo: repository?.full_name,
    issue: issue?.number,
  });

  await github.postComment(
    repository.owner,
    repository.name,
    issue.number,
    `## 📖 /zai explain\n\nCode explanation is queued on the heavy worker. (POC stub — full implementation pending.)\n\n---\n${BOT_FOOTER}\n\n${COMMENT_MARKER}`,
  );

  return {
    status: 'stub',
    action: 'explain',
    repository: repository?.full_name,
    issue: issue?.number,
  };
}

export function canHandle(commandType) {
  return commandType === 'explain';
}
