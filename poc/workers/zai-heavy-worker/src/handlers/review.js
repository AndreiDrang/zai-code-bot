/**
 * Handler for the durable `review` job — a real LLM code review.
 *
 * Thin wrapper around the shared LLM command runner
 * (shared/llm-command-runner.js): the runner owns the lifecycle (config → load
 * 5 context slices → guards → Z.ai → persist to /context/review.md → comment),
 * and this handler owns only what is review-specific — its system prompt
 * (generated/prompts.js, built from prompts/review.txt) and the response-format
 * instructions appended after the shared context block.
 *
 * Review now sends the FULL gathered context to the model: diff (primary), plus
 * commits, conversation (issue + review comments), description, and the changed
 * file list (shared/llm-context.js → buildContextBlock, command:'review').
 *
 * The LLM result is stored at `v1/prs/{repo}/{pr}/context/review.md` (overwrite,
 * one object per command) — the per-PR "latest review". Its reader is
 * readCommandResult (shared/pr-context-reader.js).
 */

import { REVIEW_MARKER } from '../../../shared/constants.js';
import { buildContextBlock } from '../../../shared/llm-context.js';
import { runLlmCommand } from '../../../shared/llm-command-runner.js';
import { REVIEW_PROMPT } from '../../generated/prompts.js';

const PROMPT_VERSION = 'review-v1';

/**
 * @param {Object} ctx
 * @param {import('../../../shared/github.js').GitHubClient} ctx.github
 * @param {Object} ctx.env  - bindings (ZAI_API_KEY, ZAI_MODEL, BOT_DB, BOT_ARTIFACTS, BOT_CACHE)
 * @param {Object} ctx.db   - D1 binding (env.BOT_DB)
 * @param {Object} ctx.job  - claimed jobs row (joined with repositories + pull_requests)
 * @param {string} ctx.runId - analysis_runs run id for this attempt
 */
export async function handleReviewCommand(ctx) {
  return runLlmCommand(ctx, {
    command: 'review',
    systemPrompt: REVIEW_PROMPT,
    buildUserPrompt: buildReviewUserPrompt,
    commentMarker: REVIEW_MARKER,
    commentKind: 'review',
    emoji: '🔍',
    promptVersion: PROMPT_VERSION,
    doneStatus: 'reviewed',
  });
}

/**
 * Builds the review user prompt: the shared context block (all 5 slices, diff
 * primary) followed by the response-format instructions. The runner calls this
 * with the freshly loaded slices + meta.
 */
function buildReviewUserPrompt({ slices, meta, maxBytes }) {
  const context = buildContextBlock({ slices, command: 'review', budgetBytes: maxBytes, meta });
  return [
    'Review the following pull request.',
    '',
    context,
    '',
    'Respond in Markdown with these sections:',
    '## Summary',
    'A 1–2 sentence overview of what this change does.',
    '## Findings',
    'Concrete issues, ordered by severity. Prefix each with **[High]**, **[Medium]**, **[Low]**, or **[Nit]**. Omit a severity that has nothing.',
    '## Notes',
    'Positive observations or non-blocking suggestions (optional).',
  ].join('\n');
}

export function canHandle(commandType) {
  return commandType === 'review';
}
