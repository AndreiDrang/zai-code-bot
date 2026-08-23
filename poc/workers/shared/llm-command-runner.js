/**
 * Shared lifecycle runner for the review LLM command. Encapsulates the durable
 * queue pipeline so the handler shrinks to its prompt + identity:
 *
 *   config → load V2 context slices → no-context guard → API-key guard
 *     → system+user prompt → Z.ai / AgentRunner → persist result to
 *     `/context/{command}.md` (overwrite) → marker-idempotent comment.
 *
 * Each handler supplies:
 *   - `command`        : name ('review') — selects the buildContextBlock layout
 *   - `systemPrompt`   : the generated system message (generated/prompts.js)
 *   - `buildUserPrompt`: ({slices, meta, metadata, maxBytes}) => user string
 *   - `commentMarker`/`commentKind`/`emoji`/`promptVersion`/`doneStatus`
 *
 * The command-result write (`prCommandResultKey`) is paired with the
 * `readCommandResult` reader (shared/pr-context-reader.js) — the anti-write-only
 * partner for the `/context/{command}.md` tier (consumed by a future
 * `/zai <cmd> --last` and the comment traceability note).
 */

import { BOT_FOOTER } from './constants.js';
import { createLogger } from './logging.js';
import { resolveSecretValue } from './secrets.js';
import { readPrSummary, renderContextSummary } from './pr-context-reader.js';
import { createContextService } from './context/context-service.js';
import { createContextToolRegistry, toOpenAiToolDefinitions } from './context-tools/registry.js';
import { createAgentRunner } from './agent/runner.js';
import { getRepositoryConfig } from './storage/config.js';
import { MAX_JOB_ATTEMPTS } from './storage/jobs.js';
import { prCommandResultKey } from './storage/keys.js';
import { upsertComment } from './comments.js';
import { createZaiClient } from './zai-client.js';

const DEFAULT_MAX_CONTEXT_BYTES = 200000;

/**
 * @param {Object} ctx
 * @param {import('./github.js').GitHubClient} ctx.github
 * @param {Object} ctx.env
 * @param {Object} ctx.db
 * @param {Object} ctx.job
 * @param {string} ctx.runId
 * @param {Object} opts - per-command parameters (see module doc)
 * @returns {Promise<Object>} status object for the queue/return
 */
export async function runLlmCommand(
  { github, env, db, job, runId },
  {
    command,
    systemPrompt,
    buildUserPrompt,
    commentMarker,
    commentKind,
    emoji,
    promptVersion,
    doneStatus,
    agentTools = false,
    agentLimits,
  },
) {
  const logger = createLogger(env, `zai-heavy-worker:${command}`);
  const {
    repository_id: repoId,
    pr_number: prNumber,
    head_sha: headSha,
    repository_owner: owner,
    repository_name: name,
    job_id: jobId,
    title,
    author_login: author,
    repository_full_name: repoFullName,
  } = job;

  const identity = {
    github,
    db,
    owner,
    repo: name,
    repoId,
    prNumber,
    headSha,
    jobId,
    command,
    emoji,
    commentMarker,
    commentKind,
  };

  const config = await getRepositoryConfig(db, env?.BOT_CACHE, repoId);
  const maxBytes = Number(config?.maxContextBytes) || DEFAULT_MAX_CONTEXT_BYTES;
  const context = createContextService({
    bucket: env?.BOT_ARTIFACTS,
    github,
    owner,
    repository: name,
    repositoryFullName: repoFullName,
    repositoryId: repoId,
    prNumber,
    expectedHeadSha: headSha,
  });
  const snapshot = await context.getSnapshotSlices({
    maxDiffBytes: maxBytes,
    includeDiff: !agentTools,
  });
  const metadata = snapshot.status === 'available' ? snapshot.metadata : null;
  const storedSummary = await readPrSummary(env?.BOT_ARTIFACTS, repoId, prNumber);
  const prSummary =
    metadata?.headSha && storedSummary?.headSha === metadata.headSha ? storedSummary.summary : null;

  // --- Build from the committed V2 snapshot; use GitHub only as a live-diff
  // fallback when no snapshot diff is available. ---
  let { diff, description, files, commits, comments } = snapshot.slices || {};
  if (!agentTools && (!diff || (typeof diff === 'string' && !diff.trim()))) {
    diff = await github.getPrDiff(owner, name, prNumber).catch(() => '');
  }
  const slices = { diff, description, files, commits, comments };

  // --- No-diff guard: nothing to act on → brief notice, job succeeds. ---
  const hasReviewableContext = agentTools
    ? Array.isArray(files) && files.length > 0
    : typeof diff === 'string' && Boolean(diff.trim());
  if (!hasReviewableContext) {
    const publication = await publishNotice(
      identity,
      metadata,
      {
        message: `No diff could be loaded for this PR, so there is nothing to ${command}.`,
      },
      logger,
    );
    return baseReturn('no_diff', {
      repository: repoFullName,
      issue: prNumber,
      headSha,
      contextReady: Boolean(metadata),
      command,
      publicationSkipped: Boolean(publication.skipped),
    });
  }

  // --- API-key guard: degrade gracefully when the deployment is unconfigured. ---
  const apiKey = await resolveSecretValue(env?.ZAI_API_KEY);
  if (!apiKey) {
    logger.warn('ZAI_API_KEY not configured; posting context-aware notice', {
      repo: repoFullName,
      issue: prNumber,
    });
    await publishNotice(
      identity,
      metadata,
      {
        message:
          `LLM ${command} is not configured on this deployment (\`ZAI_API_KEY\` is unset). ` +
          'The gathered PR context is ready and will be used once the key is configured.',
      },
      logger,
    );
    return baseReturn('no_api_key', {
      repository: repoFullName,
      issue: prNumber,
      headSha,
      contextReady: Boolean(metadata),
      command,
    });
  }

  // --- Build prompt + call Z.ai. ---
  const model = env?.ZAI_MODEL || 'glm-5.2';
  const userContent = buildUserPrompt({
    slices,
    meta: { title, author },
    metadata,
    prSummary,
    maxBytes,
    includeDiff: !agentTools,
  });
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent },
  ];
  const client = createZaiClient({ timeout: 30000, maxRetries: 3, baseDelay: 2000 });
  const result = agentTools
    ? await runAgentCommand({
        apiKey,
        client,
        context,
        logger,
        messages,
        model,
        runId,
        limits: agentLimits,
      })
    : await client.call({ apiKey, model, messages });

  if (!result.success) {
    const category = result.error?.category || 'internal';
    logger.error('Z.ai call failed', {
      repo: repoFullName,
      issue: prNumber,
      command,
      category,
      attempts: result.error?.attempts,
      providerHttpStatus: result.error?.httpStatus ?? null,
      providerRequestId: result.error?.providerRequestId ?? null,
      agentLimitReasons: result.agent?.limitReasons ?? [],
      agentDuplicateToolCalls: result.agent?.duplicateToolCalls ?? 0,
    });
    const retryable = result.error?.retryable !== false;
    const attempt = Number(job.attempt_count);
    const finalAttempt = !retryable || !Number.isInteger(attempt) || attempt >= MAX_JOB_ATTEMPTS;
    if (finalAttempt) {
      await publishNotice(
        identity,
        metadata,
        {
          message: buildFailureNotice({
            command,
            category,
            error: result.error,
            agent: result.agent,
            agentLimits,
          }),
        },
        logger,
      );
    }
    throw llmCommandError(category, retryable && !finalAttempt);
  }

  const resultData =
    command === 'review' ? appendReviewMetadata(result.data, result.agent) : result.data;

  // --- Persist result to /context/{command}.md (overwrite, per-command).
  // Best-effort: a failure here must not lose the comment. readCommandResult is
  // the reader that pairs with this write (anti-write-only).
  let resultStored = false;
  if (env?.BOT_ARTIFACTS?.put) {
    try {
      await env.BOT_ARTIFACTS.put(prCommandResultKey(repoId, prNumber, command), resultData);
      resultStored = true;
    } catch (persistError) {
      logger.error('Failed to persist command result', {
        command,
        message: persistError?.message,
        runId,
      });
    }
  }

  // --- Publish the marker-idempotent comment. ---
  const publication = await publishResult(identity, resultData, logger);

  logger.info(`${command} published`, {
    repo: repoFullName,
    issue: prNumber,
    headSha,
    model,
    promptVersion,
    resultStored,
    publicationSkipped: Boolean(publication.skipped),
    agentUsedTools: result.agent?.usedTools ?? false,
    agentIterations: result.agent?.iterations ?? null,
    agentToolCalls: result.agent?.toolCalls ?? null,
    agentRequestedToolCalls: result.agent?.requestedToolCalls ?? null,
    agentTools: result.agent?.tools ?? [],
    agentSuccessfulToolCalls: result.agent?.successfulToolCalls ?? 0,
    agentFailedToolCalls: result.agent?.failedToolCalls ?? 0,
    agentDuplicateToolCalls: result.agent?.duplicateToolCalls ?? 0,
    agentExecutedToolCalls: result.agent?.executedToolCalls ?? 0,
    agentReviewedDiffPaths: result.agent?.reviewedDiffPaths ?? [],
    agentFinalizedWithAvailableEvidence: result.agent?.finalizedWithAvailableEvidence ?? false,
    agentFinalizationReason: result.agent?.finalizationReason ?? null,
    agentLlmRequests: result.agent?.llmRequests ?? null,
    agentLlmAttempts: result.agent?.llmAttempts ?? null,
    agentLlmTimeouts: result.agent?.llmTimeouts ?? null,
    agentRetrievedBytes: result.agent?.retrievedBytes ?? 0,
    agentRetrievalBudgetExceeded: result.agent?.retrievalBudgetExceeded ?? false,
    agentLimitReasons: result.agent?.limitReasons ?? [],
  });

  return baseReturn(doneStatus, {
    repository: repoFullName,
    issue: prNumber,
    headSha,
    model,
    promptVersion,
    contextReady: Boolean(metadata),
    resultStored,
    usedFallback: Boolean(result.usedFallback),
    agentUsedTools: result.agent?.usedTools ?? false,
    agentIterations: result.agent?.iterations ?? null,
    agentToolCalls: result.agent?.toolCalls ?? null,
    agentRequestedToolCalls: result.agent?.requestedToolCalls ?? null,
    agentTools: result.agent?.tools ?? [],
    agentSuccessfulToolCalls: result.agent?.successfulToolCalls ?? 0,
    agentFailedToolCalls: result.agent?.failedToolCalls ?? 0,
    agentDuplicateToolCalls: result.agent?.duplicateToolCalls ?? 0,
    agentExecutedToolCalls: result.agent?.executedToolCalls ?? 0,
    agentReviewedDiffPaths: result.agent?.reviewedDiffPaths ?? [],
    agentFinalizedWithAvailableEvidence: result.agent?.finalizedWithAvailableEvidence ?? false,
    agentFinalizationReason: result.agent?.finalizationReason ?? null,
    agentLlmRequests: result.agent?.llmRequests ?? null,
    agentLlmAttempts: result.agent?.llmAttempts ?? null,
    agentLlmTimeouts: result.agent?.llmTimeouts ?? null,
    agentRetrievedBytes: result.agent?.retrievedBytes ?? 0,
    agentRetrievalBudgetExceeded: result.agent?.retrievalBudgetExceeded ?? false,
    agentLimitReasons: result.agent?.limitReasons ?? [],
    command,
    publicationSkipped: Boolean(publication.skipped),
  });
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function baseReturn(status, rest) {
  return { status, ...rest };
}

async function runAgentCommand({
  apiKey,
  client,
  context,
  logger,
  messages,
  model,
  runId,
  limits,
}) {
  const toolRegistry = createContextToolRegistry(context);
  const runner = createAgentRunner({
    llmClient: client,
    toolRegistry,
    logger,
    limits,
  });
  try {
    const agent = await runner.run({
      apiKey,
      model,
      messages,
      tools: toOpenAiToolDefinitions(toolRegistry.getDefinitions()),
      runId,
    });
    if (agent.status !== 'completed') {
      return {
        success: false,
        error: {
          category: agent.status === 'failed' ? agent.error?.category || 'provider' : agent.status,
          attempts: agent.error?.attempts ?? null,
          httpStatus: agent.error?.httpStatus ?? null,
          providerRequestId: agent.error?.providerRequestId ?? null,
          retryable:
            agent.status === 'failed' ? agent.error?.retryable : agent.status === 'timed_out',
        },
        agent,
      };
    }
    return {
      success: true,
      data: agent.response.content,
      usedFallback: false,
      agent,
    };
  } catch (error) {
    logger.error('Agent run failed', { runId, errorCode: 'agent_internal' });
    return {
      success: false,
      error: { category: 'agent_internal', attempts: null },
    };
  }
}

function llmCommandError(category, retryable) {
  const error = new Error(`LLM command failed: ${category}`);
  error.code = `llm_${String(category).replace(/[^a-z0-9_]/gi, '_')}`;
  error.retryable = retryable;
  return error;
}

export function buildFailureNotice({ command, category, error, agent, agentLimits }) {
  if (category === 'max_tool_calls') {
    const limit = Number(agentLimits?.maxToolCalls);
    const toolCalls = Number(agent?.toolCalls);
    const limitText = Number.isFinite(limit) && limit > 0 ? `${limit}-call` : 'tool-call';
    const progress =
      Number.isFinite(toolCalls) && toolCalls > 0
        ? ` after ${toolCalls} context request${toolCalls === 1 ? '' : 's'}`
        : '';
    const notice =
      `The ${command} reached its ${limitText} context-retrieval limit${progress}, ` +
      'so it could not produce a complete result.';
    if (agent?.retrievalBudgetExceeded) {
      const retrievalLimit = formatByteLimit(agentLimits?.maxRetrievedBytes);
      const retrieved = formatByteLimit(agent?.retrievedBytes);
      const retrievalProgress = retrieved ? ` after retrieving ${retrieved}` : '';
      const retrievalLimitText = retrievalLimit ? ` of ${retrievalLimit}` : '';
      return (
        `${notice} It also reached its context-data limit${retrievalProgress}${retrievalLimitText}. ` +
        `Please retry with \`/zai ${command}\`.`
      );
    }
    return `${notice} Please retry with \`/zai ${command}\`.`;
  }

  if (category === 'max_retrieved_bytes') {
    const limit = formatByteLimit(agentLimits?.maxRetrievedBytes);
    const retrieved = formatByteLimit(agent?.retrievedBytes);
    const progress = retrieved ? ` after retrieving ${retrieved}` : '';
    const limitText = limit ? ` of ${limit}` : '';
    return (
      `The ${command} could not retrieve more PR context${progress}${limitText} because its ` +
      `context-data limit was reached. Please retry with \`/zai ${command}\`.`
    );
  }

  const attempts = formatAttemptCount(error?.attempts);
  const notices = {
    timed_out: `The ${command} reached its execution-time limit before Z.ai produced a complete result.`,
    timeout: `Z.ai did not respond within the allowed time${attempts}.`,
    'rate-limit': `Z.ai temporarily rate-limited ${command} requests${attempts}.`,
    provider: `Z.ai was temporarily unavailable while running ${command}${attempts}.`,
    auth: `Z.ai rejected this deployment's credentials, so ${command} cannot run until a maintainer fixes the configuration.`,
    validation: `Z.ai rejected the ${command} request as invalid. A maintainer needs to inspect the deployment configuration.`,
    protocol: `Z.ai returned a response that could not be safely processed for ${command}.`,
    agent_internal: `The ${command} runner encountered an internal error before producing a result.`,
    internal: `The ${command} service encountered an internal error before producing a result.`,
  };
  return `${notices[category] || `The ${command} could not complete due to an unexpected service error.`} ${
    ['auth', 'validation'].includes(category) ? '' : `Please retry with \`/zai ${command}\`.`
  }`.trim();
}

function formatAttemptCount(value) {
  const attempts = Number(value);
  return Number.isInteger(attempts) && attempts > 0
    ? ` after ${attempts} attempt${attempts === 1 ? '' : 's'}`
    : '';
}

function formatByteLimit(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024) return `${Math.round(bytes)} bytes`;
  return `${Math.round((bytes / 1024) * 10) / 10} KiB`;
}

function appendReviewMetadata(markdown, agent = {}) {
  const toolCalls = positiveInteger(agent.toolCalls);
  const requestedToolCalls = positiveInteger(agent.requestedToolCalls);
  const successfulToolCalls = positiveInteger(agent.successfulToolCalls);
  const failedToolCalls = positiveInteger(agent.failedToolCalls);
  const duplicateToolCalls = positiveInteger(agent.duplicateToolCalls);
  const executedToolCalls = successfulToolCalls + failedToolCalls;
  const retrieved = formatByteLimit(agent.retrievedBytes) || '0 bytes';
  const reviewedDiffPaths = uniqueStringValues(agent.reviewedDiffPaths);
  const lines = [
    String(markdown || '').trimEnd(),
    '',
    '---',
    '',
    '### Review metadata',
    '',
    `- Context Tool calls executed: ${executedToolCalls} (${successfulToolCalls} successful, ${failedToolCalls} failed).`,
    `- Context Tool requests: ${requestedToolCalls}; admitted: ${toolCalls}${duplicateToolCalls ? ` (${duplicateToolCalls} duplicate request${duplicateToolCalls === 1 ? '' : 's'} skipped)` : ''}.`,
    reviewedDiffPaths.length
      ? `- Per-file diffs reviewed: ${reviewedDiffPaths.map(formatMarkdownCode).join(', ')}.`
      : '- Per-file diffs reviewed: none. Findings are based on the initial PR context and any non-diff context retrieved during this run.',
    `- Retrieved context: ${retrieved}.`,
    finalizationMetadataLine(agent),
  ];
  return lines.join('\n');
}

function finalizationMetadataLine(agent) {
  if (!agent.finalizedWithAvailableEvidence) return '- Finalization: normal completion.';
  if (agent.finalizationReason === 'tool_call_budget') {
    return '- Finalization: the Context Tool call budget was reached; this review was completed using the evidence retrieved above.';
  }
  if (agent.finalizationReason === 'retrieval_budget') {
    return '- Finalization: the context-data budget was reached; this review was completed using the evidence retrieved above.';
  }
  return '- Finalization: the 40-second time reserve started; this review was completed using the evidence retrieved above.';
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : 0;
}

function uniqueStringValues(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.filter((value) => typeof value === 'string' && value.length > 0))];
}

function formatMarkdownCode(value) {
  return `\`${value.replaceAll('\\', '\\\\').replaceAll('`', '\\`').replaceAll(/\r?\n/g, ' ')}\``;
}

/** Publishes the LLM result as a marker-idempotent comment. */
async function publishResult(identity, markdown, logger) {
  const body = `## ${identity.emoji} /zai ${identity.command}\n\n${markdown}\n\n---\n${BOT_FOOTER}\n\n${identity.commentMarker}`;
  return finishPublication(identity, logger, body);
}

/** Publishes a short, marker-wrapped notice (no-diff / no-key / failure). */
async function publishNotice(identity, metadata, { message }, logger) {
  const summary = renderContextSummary(metadata);
  const head = identity.headSha ? ` for \`${identity.headSha.slice(0, 7)}\`` : '';
  const lines = [`## ${identity.emoji} /zai ${identity.command}${head}`, '', message];
  if (summary) lines.push('', summary);
  const body = `${lines.join('\n')}\n\n---\n${BOT_FOOTER}\n\n${identity.commentMarker}`;
  return finishPublication(identity, logger, body);
}

/** Shared upsert + structured skip warning so a lost lease is never silent. */
async function finishPublication(identity, logger, body) {
  const publication = await upsertComment({
    github: identity.github,
    db: identity.db,
    owner: identity.owner,
    repo: identity.repo,
    issueNumber: identity.prNumber,
    repositoryId: identity.repoId,
    headSha: identity.headSha,
    commentKind: identity.commentKind,
    marker: identity.commentMarker,
    body,
    jobId: identity.jobId,
  });
  if (publication.skipped) {
    logger.warn('Comment publication skipped: lease held by concurrent job', {
      command: identity.command,
      repo: `${identity.owner}/${identity.repo}`,
      issue: identity.prNumber,
      jobId: identity.jobId,
      keptCommentId: publication.id,
      attempts: publication.attempts,
    });
  }
  return publication;
}
