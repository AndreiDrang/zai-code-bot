/**
 * Handler for /zai review — a HEAVY command (large diff → long LLM call).
 *
 * Context-aware stub: reads the gathered PR context (KV pr-card → head, then
 * the R2 manifest) so the queued notice reflects what the eager gather already
 * captured instead of a blind placeholder. This is the READER that pairs with
 * the pr_context gather job's writes. The LLM call + response.json output land
 * in the review feature; until then no R2 run-output is written.
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
 * @param {Object} ctx.env - bindings (BOT_CACHE, BOT_ARTIFACTS)
 * @param {Object} ctx.payload - delegation payload from the main worker
 */
export async function handleReviewCommand({ github, env, payload }) {
  const logger = createLogger(env, 'zai-heavy-worker:review');
  const { repository, issue, prNumber } = payload;
  const repoId = repository?.id;

  // KV pr-card → latest head; R2 manifest → what was gathered for that head.
  const card = await readPrCard(env.BOT_CACHE, repoId, prNumber);
  const headSha = card?.headSha ?? null;
  const manifest = headSha
    ? await readContextManifest(env.BOT_ARTIFACTS, repoId, prNumber, headSha)
    : null;

  const summary = renderContextSummary(manifest);
  const body = summary
    ? `## 🔍 /zai review\n\nReview pipeline is queued on the heavy worker.\n\n${summary}\n\nFull LLM review coming soon.\n\n---\n${BOT_FOOTER}\n\n${COMMENT_MARKER}`
    : `## 🔍 /zai review\n\nReview pipeline is queued on the heavy worker. PR context has not been gathered yet for this head — it will be fetched at review time. (POC stub — full implementation pending.)\n\n---\n${BOT_FOOTER}\n\n${COMMENT_MARKER}`;

  logger.info('review context-aware stub', {
    repo: repository?.full_name,
    issue: issue?.number,
    headSha,
    contextReady: Boolean(manifest),
  });

  await github.postComment(repository.owner, repository.name, issue.number, body);

  return {
    status: 'stub',
    action: 'review',
    repository: repository?.full_name,
    issue: issue?.number,
    headSha,
    contextReady: Boolean(manifest),
  };
}

export function canHandle(commandType) {
  return commandType === 'review';
}
