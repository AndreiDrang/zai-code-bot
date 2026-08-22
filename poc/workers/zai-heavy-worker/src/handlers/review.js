/**
 * Handler for the durable `review` job — a real LLM code review.
 *
 * Thin wrapper around the shared LLM command runner
 * (shared/llm-command-runner.js): the runner owns the lifecycle (config → load
 * 5 context slices → guards → Z.ai → persist to /context/review.md → comment),
 * and this handler owns only what is review-specific — its human-authored base
 * prompt (generated/prompts.js, built from prompts/review.txt) and static
 * review prompt composition.
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
import { runLlmCommand } from '../../../shared/llm-command-runner.js';
import {
  buildReviewInitialContext,
  buildReviewSystemPrompt,
} from '../../../shared/prompts/review.js';
import { REVIEW_PROMPT } from '../../generated/prompts.js';

const PROMPT_VERSION = 'review-v2';
const REVIEW_AGENT_LIMITS = Object.freeze({
  maxIterations: 6,
  maxToolCalls: 12,
  maxToolCallsPerIteration: 4,
  maxRetrievedBytes: 96 * 1024,
});

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
    systemPrompt: buildReviewSystemPrompt(REVIEW_PROMPT),
    buildUserPrompt: buildReviewInitialContext,
    commentMarker: REVIEW_MARKER,
    commentKind: 'review',
    emoji: '🔍',
    promptVersion: PROMPT_VERSION,
    doneStatus: 'reviewed',
    agentTools: true,
    agentLimits: REVIEW_AGENT_LIMITS,
  });
}

export function canHandle(commandType) {
  return commandType === 'review';
}
