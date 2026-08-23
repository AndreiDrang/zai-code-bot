import { createContextService } from '../../../shared/context/context-service.js';
import {
  createContextToolRegistry,
  toOpenAiToolDefinitions,
} from '../../../shared/context-tools/registry.js';
import { createAgentRunner } from '../../../shared/agent/runner.js';
import { createLogger } from '../../../shared/logging.js';
import {
  buildPrSummaryInitialContext,
  buildPrSummarySystemPrompt,
} from '../../../shared/prompts/pr-summary.js';
import { getRepositoryConfig } from '../../../shared/storage/config.js';
import { prSummaryKey } from '../../../shared/storage/keys.js';
import { resolveSecretValue } from '../../../shared/secrets.js';
import { createZaiClient } from '../../../shared/zai-client.js';
import { PR_SUMMARY_PROMPT } from '../../generated/prompts.js';

const PROMPT_VERSION = 'pr-summary-v1';
const DEFAULT_MAX_CONTEXT_BYTES = 200000;
const MODEL_TIMEOUT_MS = 45000;
const MODEL_MAX_RETRIES = 3;
const MODEL_BASE_DELAY_MS = 2000;

/**
 * Generates the structured initial PR context after `pr_context` has committed
 * a snapshot. Inexpensive PR metadata is sent eagerly; diffs and repository
 * source are retrieved lazily through Context Tools. This job deliberately
 * does not publish a GitHub comment: its JSON artifact is auxiliary context for
 * later `/zai review` runs.
 */
export async function handlePrSummaryJob({ github, env, db, job, runId }) {
  const logger = createLogger(env, 'zai-heavy-worker:pr-summary');
  const {
    repository_id: repoId,
    pr_number: prNumber,
    head_sha: headSha,
    title,
    author_login: author,
    repository_full_name: repoFullName,
    repository_owner: owner,
    repository_name: repository,
  } = job;

  const bucket = env?.BOT_ARTIFACTS;
  const config = await getRepositoryConfig(db, env?.BOT_CACHE, repoId);
  const maxBytes = Number(config?.maxContextBytes) || DEFAULT_MAX_CONTEXT_BYTES;
  const context = createContextService({
    bucket,
    github,
    owner,
    repository,
    repositoryFullName: repoFullName,
    repositoryId: repoId,
    prNumber,
    expectedHeadSha: headSha,
  });
  const snapshot = await context.getSnapshotSlices({ includeDiff: false });

  if (snapshot.status === 'stale') {
    return {
      status: 'stale',
      action: 'pr_summary',
      repository: repoFullName,
      issue: prNumber,
      headSha,
      currentHeadSha: snapshot.headSha,
    };
  }
  const metadata = snapshot.status === 'available' ? snapshot.metadata : null;
  const slices = snapshot.status === 'available' ? snapshot.slices : null;

  if (!metadata) {
    const error = new Error('PR context manifest is missing');
    error.code = 'pr_summary_context_stale';
    error.retryable = true;
    throw error;
  }
  if (metadata.headSha !== headSha) {
    return {
      status: 'stale',
      action: 'pr_summary',
      repository: repoFullName,
      issue: prNumber,
      headSha,
      currentHeadSha: metadata.headSha,
    };
  }

  const apiKey = await resolveSecretValue(env?.ZAI_API_KEY);

  if (!apiKey) {
    logger.warn('ZAI_API_KEY not configured; PR summary was not generated', {
      repo: repoFullName,
      issue: prNumber,
      headSha,
    });
    return {
      status: 'no_api_key',
      action: 'pr_summary',
      repository: repoFullName,
      issue: prNumber,
      headSha,
    };
  }

  const userContent = buildPrSummaryInitialContext({
    slices,
    metadata: {
      ...metadata,
      title: title || metadata.title,
      author: author || metadata.author,
    },
    maxBytes,
  });
  const model = env?.ZAI_MODEL || 'glm-5.2';
  const client = createZaiClient({
    timeout: MODEL_TIMEOUT_MS,
    maxRetries: MODEL_MAX_RETRIES,
    baseDelay: MODEL_BASE_DELAY_MS,
  });
  const toolRegistry = createContextToolRegistry(context);
  const runner = createAgentRunner({
    llmClient: client,
    toolRegistry,
    logger,
  });
  const agent = await runner.run({
    apiKey,
    model,
    messages: [
      {
        role: 'system',
        content: buildPrSummarySystemPrompt(PR_SUMMARY_PROMPT),
      },
      { role: 'user', content: userContent },
    ],
    tools: toOpenAiToolDefinitions(toolRegistry.getDefinitions()),
    runId,
  });

  if (agent.status !== 'completed') {
    const category = String(
      agent.status === 'failed' ? agent.error?.category || 'internal' : agent.status,
    ).replace(/[^a-z0-9_]/gi, '_');
    const error = new Error(`PR summary LLM call failed: ${category}`);
    error.code = `pr_summary_${category}`;
    error.retryable = agent.error?.retryable !== false;
    throw error;
  }

  let summary;
  try {
    summary = validatePrSummary(JSON.parse(String(agent.response.content)));
  } catch (error) {
    const invalid = new Error('Z.ai returned an invalid PR summary');
    invalid.code = 'pr_summary_invalid_json';
    invalid.retryable = true;
    invalid.cause = error;
    throw invalid;
  }

  // A newer synchronize event may have replaced the manifest while the model
  // was running. Never let an older answer overwrite the current summary.
  const latestSnapshot = await createContextService({
    bucket,
    repositoryId: repoId,
    prNumber,
  }).getSnapshotState();
  if (latestSnapshot.headSha !== headSha) {
    logger.warn('Discarded stale PR summary', {
      repo: repoFullName,
      issue: prNumber,
      headSha,
      currentHeadSha: latestSnapshot.headSha,
    });
    return {
      status: 'stale',
      action: 'pr_summary',
      repository: repoFullName,
      issue: prNumber,
      headSha,
    };
  }

  if (!bucket?.put) {
    return {
      status: 'no_storage',
      action: 'pr_summary',
      repository: repoFullName,
      issue: prNumber,
      headSha,
    };
  }

  const artifact = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    headSha,
    sourceManifestUpdatedAt: snapshot.gatheredAt,
    model,
    promptVersion: PROMPT_VERSION,
    summary,
  };
  await bucket.put(prSummaryKey(repoId, prNumber), JSON.stringify(artifact, null, 2), {
    httpMetadata: { contentType: 'application/json' },
  });

  logger.info('Generated PR summary', {
    repo: repoFullName,
    issue: prNumber,
    headSha,
    model,
    promptVersion: PROMPT_VERSION,
    agentUsedTools: agent.usedTools,
    agentIterations: agent.iterations,
    agentToolCalls: agent.toolCalls,
    agentTools: agent.tools,
    agentSuccessfulToolCalls: agent.successfulToolCalls,
    agentFailedToolCalls: agent.failedToolCalls,
    agentLlmRequests: agent.llmRequests,
    agentLlmAttempts: agent.llmAttempts,
    agentLlmTimeouts: agent.llmTimeouts,
    agentRetrievedBytes: agent.retrievedBytes,
    agentRetrievalBudgetExceeded: agent.retrievalBudgetExceeded,
  });
  return {
    status: 'success',
    action: 'pr_summary',
    repository: repoFullName,
    issue: prNumber,
    headSha,
    model,
    promptVersion: PROMPT_VERSION,
    agentUsedTools: agent.usedTools,
    agentIterations: agent.iterations,
    agentToolCalls: agent.toolCalls,
    agentTools: agent.tools,
    agentSuccessfulToolCalls: agent.successfulToolCalls,
    agentFailedToolCalls: agent.failedToolCalls,
    agentLlmRequests: agent.llmRequests,
    agentLlmAttempts: agent.llmAttempts,
    agentLlmTimeouts: agent.llmTimeouts,
    agentRetrievedBytes: agent.retrievedBytes,
    agentRetrievalBudgetExceeded: agent.retrievalBudgetExceeded,
  };
}

export function validatePrSummary(value) {
  if (!isPlainObject(value)) throw new TypeError('summary must be an object');
  assertExactKeys(value, ['prSummary', 'keyChanges', 'conversationSummary']);
  const prSummary = boundedString(value.prSummary, 1500, 'prSummary');
  if (!Array.isArray(value.keyChanges) || value.keyChanges.length > 20) {
    throw new TypeError('keyChanges must be an array with at most 20 items');
  }
  const keyChanges = value.keyChanges.map((change) => {
    if (!isPlainObject(change)) throw new TypeError('keyChanges item must be an object');
    assertExactKeys(change, ['file', 'change']);
    return {
      file: boundedString(change.file, 300, 'keyChanges.file'),
      change: boundedString(change.change, 500, 'keyChanges.change'),
    };
  });

  const conversation = value.conversationSummary;
  if (!isPlainObject(conversation)) {
    throw new TypeError('conversationSummary must be an object');
  }
  assertExactKeys(conversation, ['mainTopic', 'unresolvedQuestions', 'resolvedQuestions']);
  const mainTopic =
    conversation.mainTopic === null
      ? null
      : boundedString(conversation.mainTopic, 500, 'conversationSummary.mainTopic');
  if (
    !Array.isArray(conversation.unresolvedQuestions) ||
    conversation.unresolvedQuestions.length > 20
  ) {
    throw new TypeError('unresolvedQuestions must be an array with at most 20 items');
  }
  const unresolvedQuestions = conversation.unresolvedQuestions.map((question) =>
    boundedString(question, 500, 'conversationSummary.unresolvedQuestions'),
  );
  if (!Number.isInteger(conversation.resolvedQuestions) || conversation.resolvedQuestions < 0) {
    throw new TypeError('resolvedQuestions must be a non-negative integer');
  }

  return {
    prSummary,
    keyChanges,
    conversationSummary: {
      mainTopic,
      unresolvedQuestions,
      resolvedQuestions: conversation.resolvedQuestions,
    },
  };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertExactKeys(value, expected) {
  const actual = Object.keys(value).sort();
  const allowed = [...expected].sort();
  if (actual.length !== allowed.length || actual.some((key, index) => key !== allowed[index])) {
    throw new TypeError(`Unexpected summary fields; expected ${expected.join(', ')}`);
  }
}

function boundedString(value, maxLength, name) {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new TypeError(`${name} must be a non-empty string of at most ${maxLength} characters`);
  }
  return value.trim();
}

export function canHandle(commandType) {
  return commandType === 'pr_summary';
}
