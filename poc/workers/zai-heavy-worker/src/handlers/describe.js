/**
 * Durable handler for `/zai describe`.
 *
 * The command synthesizes a PR description from commit messages and updates
 * only the bot-owned section of the PR body. The result and status comment are
 * both idempotent.
 */

import { DESCRIBE_MARKER, BOT_FOOTER } from '../../../shared/constants.js';
import { createAgentRunner } from '../../../shared/agent/runner.js';
import {
  createContextToolRegistry,
  toOpenAiToolDefinitions,
} from '../../../shared/context-tools/registry.js';
import { createContextService } from '../../../shared/context/context-service.js';
import { createLogger } from '../../../shared/logging.js';
import {
  buildDescribeInitialContext,
  buildDescribeSystemPrompt,
} from '../../../shared/prompts/describe.js';
import { readContextManifest } from '../../../shared/pr-context-reader.js';
import { getRepositoryConfig } from '../../../shared/storage/config.js';
import { MAX_JOB_ATTEMPTS } from '../../../shared/storage/jobs.js';
import { prCommandResultKey } from '../../../shared/storage/keys.js';
import { upsertComment } from '../../../shared/comments.js';
import { resolveSecretValue } from '../../../shared/secrets.js';
import { createZaiClient } from '../../../shared/zai-client.js';

const DESCRIPTION_START = '<!-- zai-description-start -->';
const DESCRIPTION_END = '<!-- zai-description-end -->';
const MAX_COMMIT_CHARS = 8000;
const DEFAULT_MAX_CONTEXT_BYTES = 200000;
const PROMPT_VERSION = 'describe-v1';

const DESCRIBE_PROMPT = `You are an expert Staff Engineer and technical writer.
Synthesize a clear, comprehensive pull request description from the supplied
pull request context. Use commit messages to establish the change history,
then retrieve targeted diff or source context only when it is needed to
describe an important change accurately. Group related changes instead of
repeating commits, ignore trivial or redundant messages, and infer intent only
when the available context supports it.

Use a professional, objective tone and imperative bullet points. Return only
Markdown with these optional sections, omitting empty sections:

## 🚀 Overview
One or two sentences describing the purpose and value of the pull request.

## ✨ Features & Enhancements
New functionality or meaningful improvements.

## 🐛 Bug Fixes
Problems resolved by the changes.

## 🔨 Refactoring & Chore
Restructuring, cleanup, and technical-debt work.

## ⚙️ Infrastructure & Tooling
CI/CD, dependencies, and configuration changes.`;

/**
 * @param {{github: Object, env: Object, db: Object, job: Object, runId: string}} ctx
 */
export async function handleDescribeCommand({ github, env, db, job, runId }) {
  const logger = createLogger(env, 'zai-heavy-worker:describe');
  const {
    repository_id: repoId,
    pr_number: prNumber,
    repository_owner: owner,
    repository_name: name,
    head_sha: headSha,
    job_id: jobId,
    repository_full_name: repoFullName,
  } = job;

  const manifest = await readContextManifest(env?.BOT_ARTIFACTS, repoId, prNumber);
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
  const snapshot = await context.getSnapshotSlices({ includeDiff: false });
  const metadata = snapshot.status === 'available' ? snapshot.metadata : null;
  const slices = snapshot.status === 'available' ? snapshot.slices : {};
  let commits = slices.commits;
  if (!Array.isArray(commits) || commits.length === 0) {
    commits = await github.getPrCommits(owner, name, prNumber, 1, 30).catch(() => []);
    slices.commits = commits;
  }

  const commitMessages = truncate(
    (Array.isArray(commits) ? commits : [])
      .map((commit) => commit?.message || commit?.commit?.message || '')
      .filter(Boolean)
      .join('\n\n'),
    MAX_COMMIT_CHARS,
  );

  const identity = {
    github,
    db,
    owner,
    repo: name,
    prNumber,
    repoId,
    headSha,
    jobId,
    manifest,
  };

  if (!commitMessages) {
    await publishStatus(identity, 'No commits could be loaded for this PR.', 'no_commits', logger);
    return result('no_commits', repoFullName, prNumber);
  }

  const apiKey = await resolveSecretValue(env?.ZAI_API_KEY);
  if (!apiKey) {
    await publishStatus(
      identity,
      'Description generation is not configured (`ZAI_API_KEY` is unset).',
      'no_api_key',
      logger,
    );
    return result('no_api_key', repoFullName, prNumber);
  }

  const client = createZaiClient({
    timeout: Number(config?.timeout) || 30000,
    maxRetries: 3,
    baseDelay: 2000,
  });
  const toolRegistry = createContextToolRegistry(context);
  const runner = createAgentRunner({
    llmClient: client,
    toolRegistry,
    logger,
  });
  const agent = await runner.run({
    apiKey,
    model: env?.ZAI_MODEL || 'glm-5.2',
    messages: [
      { role: 'system', content: buildDescribeSystemPrompt(DESCRIBE_PROMPT) },
      {
        role: 'user',
        content: buildDescribeInitialContext({
          slices,
          metadata: metadata || {
            repository: repoFullName,
            pullRequest: prNumber,
            headSha,
          },
          maxBytes,
        }),
      },
    ],
    tools: toOpenAiToolDefinitions(toolRegistry.getDefinitions()),
    runId,
  });

  if (agent.status !== 'completed') {
    const category = agent.status === 'failed' ? agent.error?.category || 'internal' : agent.status;
    const retryable =
      agent.status === 'failed' ? agent.error?.retryable !== false : agent.status === 'timed_out';
    const attempt = Number(job.attempt_count);
    const finalAttempt = !retryable || !Number.isInteger(attempt) || attempt >= MAX_JOB_ATTEMPTS;
    logger.error('Z.ai describe call failed', {
      repo: repoFullName,
      issue: prNumber,
      category,
      runId,
    });
    if (finalAttempt) {
      await publishStatus(
        identity,
        `The description could not be generated (${category}). Please retry.`,
        'llm_failed',
        logger,
      );
    }
    throw describeCommandError(category, retryable && !finalAttempt);
  }

  const generated = String(agent.response.content || '').trim();
  const pullRequest = await github.getPullRequest(owner, name, prNumber);
  const body = replaceGeneratedDescription(pullRequest?.body || '', generated);
  await github.updatePullRequest(owner, name, prNumber, { body });

  let resultStored = false;
  if (env?.BOT_ARTIFACTS?.put) {
    try {
      await env.BOT_ARTIFACTS.put(prCommandResultKey(repoId, prNumber, 'describe'), generated);
      resultStored = true;
    } catch (error) {
      logger.error('Failed to persist describe result', { message: error?.message, runId });
    }
  }

  await publishStatus(
    identity,
    'The PR description was updated from its commit history.',
    'updated',
    logger,
  );
  logger.info('Describe updated pull request', {
    repo: repoFullName,
    issue: prNumber,
    headSha,
    model: env?.ZAI_MODEL || 'glm-5.2',
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
    ...result('updated', repoFullName, prNumber),
    model: env?.ZAI_MODEL || 'glm-5.2',
    promptVersion: PROMPT_VERSION,
    resultStored,
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

function truncate(value, max) {
  return value.length > max ? `${value.slice(0, max)}\n\n[commit history truncated]` : value;
}

function replaceGeneratedDescription(body, generated) {
  const block = `${DESCRIPTION_START}\n${generated}\n${DESCRIPTION_END}`;
  const start = body.indexOf(DESCRIPTION_START);
  const end = body.indexOf(DESCRIPTION_END, start);
  if (start === -1) return `${body.trimEnd()}\n\n${block}`.trim();
  return `${body.slice(0, start).trimEnd()}\n\n${block}${end === -1 ? '' : body.slice(end + DESCRIPTION_END.length)}`.trim();
}

async function publishStatus(identity, message, status, logger = null) {
  const summary = identity.manifest
    ? `\n\nContext snapshot: \`${identity.manifest.headSha}\`.`
    : '';
  const publication = await upsertComment({
    github: identity.github,
    db: identity.db,
    owner: identity.owner,
    repo: identity.repo,
    issueNumber: identity.prNumber,
    repositoryId: identity.repoId,
    headSha: identity.headSha,
    commentKind: 'describe',
    marker: DESCRIBE_MARKER,
    body: `## 📝 /zai describe\n\n${message}${summary}\n\n---\n${BOT_FOOTER}\n\n${DESCRIBE_MARKER}`,
    jobId: identity.jobId,
  });
  if (publication?.skipped && logger) {
    logger.warn('Describe status publication skipped: lease held by concurrent job', {
      repo: `${identity.owner}/${identity.repo}`,
      issue: identity.prNumber,
      jobId: identity.jobId,
      status,
      keptCommentId: publication.id ?? null,
      attempts: publication.attempts ?? null,
    });
  }
  return publication;
}

function result(status, repository, issue) {
  return { status, action: 'describe', repository, issue };
}

function describeCommandError(category, retryable) {
  const error = new Error(`Describe command failed: ${category}`);
  error.code = `llm_${String(category).replace(/[^a-z0-9_]/gi, '_')}`;
  error.retryable = retryable;
  return error;
}

export function canHandle(commandType) {
  return commandType === 'describe';
}
