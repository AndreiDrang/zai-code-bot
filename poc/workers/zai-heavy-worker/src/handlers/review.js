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
 * Review sends the full inexpensive context to the model: commits, conversation
 * (issue + review comments), description, and the changed-file list. Individual
 * diffs and source files are fetched lazily through Context Tools.
 *
 * The LLM result is stored at `v2/prs/{repo}/{pr}/context/review.md` (overwrite,
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
    agentTools: true,
  });
}

/**
 * Builds the review user prompt: the inexpensive snapshot context followed by
 * response-format instructions. The AgentRunner supplies tools for large diff
 * and source artifacts.
 */
function buildReviewUserPrompt({ slices, meta, metadata, prSummary, maxBytes, includeDiff }) {
  const context = buildContextBlock({
    slices,
    command: 'review',
    budgetBytes: maxBytes,
    meta,
    summary: prSummary,
    includeDiff,
  });
  return [
    'Review the following pull request.',
    'The pull request metadata, description, commits, comments, and changed-file map are provided below.',
    'Use the available tools to inspect a specific diff or repository file before reporting a concrete finding.',
    '',
    'Pull request metadata:',
    '```json',
    JSON.stringify(metadata),
    '```',
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
