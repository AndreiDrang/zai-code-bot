/**
 * Handler for /zai impact — a HEAVY command (impact/risk analysis → LLM).
 *
 * Context-aware stub: reads the gathered PR context (KV pr-card → head, then
 * the R2 manifest) so the queued risk-analysis notice reflects what the eager
 * gather already captured. Reader pairing with the pr_context gather job; the
 * LLM call lands with the impact feature.
 */

import { COMMENT_MARKER, BOT_FOOTER } from '../../../shared/constants.js';
import { createLogger } from '../../../shared/logging.js';
import {
  readPrCard,
  readContextManifest,
  renderContextSummary,
} from '../../../shared/pr-context-reader.js';

/**
 * @param {Object} ctx
 * @param {import('../../shared/github.js').GitHubClient} ctx.github
 * @param {Object} ctx.env
 * @param {Object} ctx.payload
 */
export async function handleImpactCommand({ github, env, payload }) {
  const logger = createLogger(env, 'zai-heavy-worker:impact');
  const { repository, issue, prNumber } = payload;
  const repoId = repository?.id;

  const card = await readPrCard(env.BOT_CACHE, repoId, prNumber);
  const headSha = card?.headSha ?? null;
  const manifest = await readContextManifest(env.BOT_ARTIFACTS, repoId, prNumber);

  const summary = renderContextSummary(manifest);
  const body = summary
    ? `## 📊 /zai impact\n\nImpact & risk analysis is queued on the heavy worker.\n\n${summary}\n\nFull LLM impact analysis coming soon.\n\n---\n${BOT_FOOTER}\n\n${COMMENT_MARKER}`
    : `## 📊 /zai impact\n\nImpact & risk analysis is queued on the heavy worker. PR context has not been gathered yet for this head — it will be fetched at analysis time. (POC stub — full implementation pending.)\n\n---\n${BOT_FOOTER}\n\n${COMMENT_MARKER}`;

  logger.info('impact context-aware stub', {
    repo: repository?.full_name,
    issue: issue?.number,
    headSha,
    contextReady: Boolean(manifest),
  });

  await github.postComment(repository.owner, repository.name, issue.number, body);

  return {
    status: 'stub',
    action: 'impact',
    repository: repository?.full_name,
    issue: issue?.number,
    headSha,
    contextReady: Boolean(manifest),
  };
}

export function canHandle(commandType) {
  return commandType === 'impact';
}
