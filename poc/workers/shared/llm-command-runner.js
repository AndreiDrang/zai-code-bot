/**
 * Shared lifecycle runner for the review LLM command. Encapsulates the durable
 * queue pipeline so the handler shrinks to its prompt + identity:
 *
 *   config → load V2 context slices (live diff fallback) → no-diff guard
 *     → API-key guard → system+user prompt → Z.ai → persist result to
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
import { getRepositoryConfig } from './storage/config.js';
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
  const snapshot = await context.getSnapshotSlices({ maxDiffBytes: maxBytes });
  const metadata = snapshot.status === 'available' ? snapshot.metadata : null;
  const storedSummary = await readPrSummary(env?.BOT_ARTIFACTS, repoId, prNumber);
  const prSummary =
    metadata?.headSha && storedSummary?.headSha === metadata.headSha ? storedSummary.summary : null;

  // --- Build from the committed V2 snapshot; use GitHub only as a live-diff
  // fallback when no snapshot diff is available. ---
  let { diff, description, files, commits, comments } = snapshot.slices || {};
  if (!diff || (typeof diff === 'string' && !diff.trim())) {
    diff = await github.getPrDiff(owner, name, prNumber).catch(() => '');
  }
  const slices = { diff, description, files, commits, comments };

  // --- No-diff guard: nothing to act on → brief notice, job succeeds. ---
  if (!diff || (typeof diff === 'string' && !diff.trim())) {
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
  });
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent },
  ];
  const client = createZaiClient({ timeout: 30000, maxRetries: 3, baseDelay: 2000 });
  const result = await client.call({ apiKey, model, messages });

  if (!result.success) {
    const category = result.error?.category || 'internal';
    logger.error('Z.ai call failed', {
      repo: repoFullName,
      issue: prNumber,
      command,
      category,
      attempts: result.error?.attempts,
    });
    await publishNotice(identity, metadata, {
      message: `The LLM ${command} could not complete (${category}). Please retry with \`/zai ${command}\`.`,
    });
    return baseReturn('llm_failed', {
      repository: repoFullName,
      issue: prNumber,
      headSha,
      errorCode: category,
      command,
    });
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
    command,
  });
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function baseReturn(status, rest) {
  return { status, ...rest };
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
