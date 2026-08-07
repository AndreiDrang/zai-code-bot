/**
 * Handler for /zai describe — a HEAVY command (commits -> LLM -> PR description).
 *
 * STUB: posts a placeholder notice. When implemented, mirrors the parent bot's
 * describe handler: fetch PR commits, build a description prompt, call the
 * Z.ai API, post the generated description.
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
export async function handleDescribeCommand({ github, payload }) {
  const logger = createLogger({ NODE_ENV: 'production' }, 'zai-heavy-worker:describe');
  const { repository, issue } = payload;

  logger.info('describe stub', {
    repo: repository?.full_name,
    issue: issue?.number,
  });

  await github.postComment(
    repository.owner,
    repository.name,
    issue.number,
    `## 📝 /zai describe\n\nPR description generation is queued on the heavy worker. (POC stub — full implementation pending.)\n\n---\n${BOT_FOOTER}\n\n${COMMENT_MARKER}`,
  );

  return {
    status: 'stub',
    action: 'describe',
    repository: repository?.full_name,
    issue: issue?.number,
  };
}

export function canHandle(commandType) {
  return commandType === 'describe';
}
