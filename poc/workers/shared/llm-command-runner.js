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
    await publishNotice(identity, metadata, {
      message: `No diff could be loaded for this PR, so there is nothing to ${command}.`,
    });
    return baseReturn('no_diff', {
      repository: repoFullName,
      issue: prNumber,
      headSha,
      contextReady: Boolean(metadata),
      command,
    });
  }

  // --- API-key guard: degrade gracefully when the deployment is unconfigured. ---
  const apiKey = await resolveSecretValue(env?.ZAI_API_KEY);
  if (!apiKey) {
    logger.warn('ZAI_API_KEY not configured; posting context-aware notice', {
      repo: repoFullName,
      issue: prNumber,
    });
    await publishNotice(identity, metadata, {
      message:
        `LLM ${command} is not configured on this deployment (\`ZAI_API_KEY\` is unset). ` +
        'The gathered PR context is ready and will be used once the key is configured.',
    });
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
      agentLimitReasons: result.agent?.limitReasons ?? [],
      agentDuplicateToolCalls: result.agent?.duplicateToolCalls ?? 0,
    });
    const retryable = result.error?.retryable !== false;
    const attempt = Number(job.attempt_count);
    const finalAttempt =
      !retryable || !Number.isInteger(attempt) || attempt >= MAX_JOB_ATTEMPTS;
    if (finalAttempt) {
      await publishNotice(identity, metadata, {
        message: buildFailureNotice({
          command,
          category,
          error: result.error,
          agent: result.agent,
          agentLimits,
        }),
      });
    }
    throw llmCommandError(category, retryable && !finalAttempt);
  }

  // --- Persist result to /context/{command}.md (overwrite, per-command).
  // Best-effort: a failure here must not lose the comment. readCommandResult is
  // the reader that pairs with this write (anti-write-only).
  let resultStored = false;
  if (env?.BOT_ARTIFACTS?.put) {
    try {
      await env.BOT_ARTIFACTS.put(prCommandResultKey(repoId, prNumber, command), result.data);
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
  await publishResult(identity, result.data);

  logger.info(`${command} published`, {
    repo: repoFullName,
    issue: prNumber,
    headSha,
    model,
    promptVersion,
    resultStored,
    agentUsedTools: result.agent?.usedTools ?? false,
    agentIterations: result.agent?.iterations ?? null,
    agentToolCalls: result.agent?.toolCalls ?? null,
    agentTools: result.agent?.tools ?? [],
    agentSuccessfulToolCalls: result.agent?.successfulToolCalls ?? 0,
    agentFailedToolCalls: result.agent?.failedToolCalls ?? 0,
    agentDuplicateToolCalls: result.agent?.duplicateToolCalls ?? 0,
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
    agentTools: result.agent?.tools ?? [],
    agentSuccessfulToolCalls: result.agent?.successfulToolCalls ?? 0,
    agentFailedToolCalls: result.agent?.failedToolCalls ?? 0,
    agentDuplicateToolCalls: result.agent?.duplicateToolCalls ?? 0,
    agentLlmRequests: result.agent?.llmRequests ?? null,
    agentLlmAttempts: result.agent?.llmAttempts ?? null,
    agentLlmTimeouts: result.agent?.llmTimeouts ?? null,
    agentRetrievedBytes: result.agent?.retrievedBytes ?? 0,
    agentRetrievalBudgetExceeded: result.agent?.retrievalBudgetExceeded ?? false,
    agentLimitReasons: result.agent?.limitReasons ?? [],
    command,
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
          retryable:
            agent.status === 'failed'
              ? agent.error?.retryable
              : agent.status === 'timed_out',
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

  if (category === 'max_iterations') {
    const limit = Number(agentLimits?.maxIterations);
    const toolCalls = Number(agent?.toolCalls);
    const limitText = Number.isFinite(limit) && limit > 0 ? `${limit}-turn` : 'investigation';
    const progress =
      Number.isFinite(toolCalls) && toolCalls > 0
        ? ` after ${toolCalls} context request${toolCalls === 1 ? '' : 's'}`
        : '';
    return (
      `The ${command} reached its ${limitText} investigation limit${progress} before producing ` +
      `a complete result. Please retry with \`/zai ${command}\`.`
    );
  }

  const attempts = formatAttemptCount(error?.attempts);
  const notices = {
    timed_out:
      `The ${command} reached its execution-time limit before Z.ai produced a complete result.`,
    timeout: `Z.ai did not respond within the allowed time${attempts}.`,
    'rate-limit': `Z.ai temporarily rate-limited ${command} requests${attempts}.`,
    provider: `Z.ai was temporarily unavailable while running ${command}${attempts}.`,
    auth:
      `Z.ai rejected this deployment's credentials, so ${command} cannot run until a maintainer fixes the configuration.`,
    validation:
      `Z.ai rejected the ${command} request as invalid. A maintainer needs to inspect the deployment configuration.`,
    protocol:
      `Z.ai returned a response that could not be safely processed for ${command}.`,
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

/** Publishes the LLM result as a marker-idempotent comment. */
async function publishResult(identity, markdown) {
  const body = `## ${identity.emoji} /zai ${identity.command}\n\n${markdown}\n\n---\n${BOT_FOOTER}\n\n${identity.commentMarker}`;
  return upsertComment({
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
}

/** Publishes a short, marker-wrapped notice (no-diff / no-key / failure). */
async function publishNotice(identity, metadata, { message }) {
  const summary = renderContextSummary(metadata);
  const head = identity.headSha ? ` for \`${identity.headSha.slice(0, 7)}\`` : '';
  const lines = [`## ${identity.emoji} /zai ${identity.command}${head}`, '', message];
  if (summary) lines.push('', summary);
  const body = `${lines.join('\n')}\n\n---\n${BOT_FOOTER}\n\n${identity.commentMarker}`;
  return upsertComment({
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
}
