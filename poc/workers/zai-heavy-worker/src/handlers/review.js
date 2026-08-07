/**
 * Handler for the durable `review` job — a real LLM code review.
 *
 * Runs on the QUEUE path with full {github, env, db, job, runId}: it reads the
 * gathered PR context (KV pr-card → head; R2 manifest + diff/description
 * slices, with a live getPrDiff fallback), builds a bounded review prompt under
 * the repo's maxContextBytes budget, calls Z.ai, persists the raw response as a
 * `response.json` run-output artifact (the run-output tier's FIRST writer — its
 * reader is the analysis_runs index), and publishes a marker-idempotent review
 * comment via upsertComment.
 *
 * This is the LLM feature that closes two anti-write-only loops at once: the
 * Z.ai client gets its first caller, and writeArtifact/linkRunResultArtifact
 * get their first producer.
 */

import { REVIEW_MARKER, BOT_FOOTER } from '../../../shared/constants.js';
import { createLogger } from '../../../shared/logging.js';
import { resolveSecretValue } from '../../../shared/secrets.js';
import {
  readContextManifest,
  readContextSlice,
  renderContextSummary,
} from '../../../shared/pr-context-reader.js';
import { getRepositoryConfig } from '../../../shared/storage/config.js';
import { createZaiClient } from '../../../shared/zai-client.js';
import { writeArtifact } from '../../../shared/storage/artifacts.js';
import { linkRunResultArtifact } from '../../../shared/storage/jobs.js';
import { upsertComment } from '../../../shared/comments.js';

const PROMPT_VERSION = 'review-v1';
const DEFAULT_MAX_CONTEXT_BYTES = 200000;
const REVIEW_SYSTEM_MESSAGE =
  'You are an expert code reviewer. Review the provided code changes and give ' +
  'clear, actionable feedback. Be concise and focus on correctness, security, ' +
  'and maintainability. Respond in Markdown only.';

/**
 * @param {Object} ctx
 * @param {import('../../../shared/github.js').GitHubClient} ctx.github
 * @param {Object} ctx.env  - bindings (ZAI_API_KEY, ZAI_MODEL, BOT_DB, BOT_ARTIFACTS, BOT_CACHE)
 * @param {Object} ctx.db   - D1 binding (env.BOT_DB)
 * @param {Object} ctx.job  - claimed jobs row (joined with repositories + pull_requests)
 * @param {string} ctx.runId - analysis_runs run id for this attempt
 */
export async function handleReviewCommand({ github, env, db, job, runId }) {
  const logger = createLogger(env, 'zai-heavy-worker:review');
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

  const config = await getRepositoryConfig(db, env?.BOT_CACHE, repoId);
  const maxBytes = Number(config.maxContextBytes) || DEFAULT_MAX_CONTEXT_BYTES;

  // --- Resolve context: gathered first (per-PR latest), live fallback for diff. ---
  const manifest = await readContextManifest(env?.BOT_ARTIFACTS, repoId, prNumber);
  let diff = await readContextSlice(env?.BOT_ARTIFACTS, repoId, prNumber, 'diff');
  if (diff == null) diff = await github.getPrDiff(owner, name, prNumber).catch(() => '');
  diff = typeof diff === 'string' ? diff.slice(0, maxBytes) : '';

  const description = await readContextSlice(env?.BOT_ARTIFACTS, repoId, prNumber, 'description');
  const filesSlice = await readContextSlice(env?.BOT_ARTIFACTS, repoId, prNumber, 'files');
  const fileNames = Array.isArray(filesSlice)
    ? filesSlice.map((f) => f?.filename).filter(Boolean)
    : null;

  if (!diff) {
    // Nothing to review — post a brief notice and succeed (not a job failure).
    await publishReviewComment({
      github,
      db,
      owner,
      repo: name,
      repoId,
      prNumber,
      headSha,
      jobId,
      markdown: noticeBody('No diff could be loaded for this PR, so there is nothing to review.', {
        manifest,
        headSha,
      }),
    });
    return {
      status: 'no_diff',
      action: 'review',
      repository: repoFullName,
      issue: prNumber,
      headSha,
      contextReady: Boolean(manifest),
    };
  }

  // --- Resolve the Z.ai key (degrade gracefully if unconfigured). ---
  const apiKey = await resolveSecretValue(env?.ZAI_API_KEY);
  if (!apiKey) {
    logger.warn('ZAI_API_KEY not configured; posting context-aware notice', {
      repo: repoFullName,
      issue: prNumber,
    });
    await publishReviewComment({
      github,
      db,
      owner,
      repo: name,
      repoId,
      prNumber,
      headSha,
      jobId,
      markdown: noticeBody(
        'LLM review is not configured on this deployment (`ZAI_API_KEY` is unset). ' +
          'The gathered PR context is ready and will be used once the key is configured.',
        { manifest, headSha },
      ),
    });
    return {
      status: 'no_api_key',
      action: 'review',
      repository: repoFullName,
      issue: prNumber,
      headSha,
      contextReady: Boolean(manifest),
    };
  }

  // --- Build the prompt + call Z.ai. ---
  const model = env?.ZAI_MODEL || 'glm-5.2';
  const messages = [
    { role: 'system', content: REVIEW_SYSTEM_MESSAGE },
    { role: 'user', content: buildReviewPrompt({ title, author, description, fileNames, diff }) },
  ];
  const client = createZaiClient({
    timeout: 30000,
    maxRetries: 3,
    baseDelay: 2000,
  });
  const result = await client.call({ apiKey, model, messages });

  if (!result.success) {
    const category = result.error?.category || 'internal';
    logger.error('Z.ai review call failed', {
      repo: repoFullName,
      issue: prNumber,
      category,
      attempts: result.error?.attempts,
    });
    await publishReviewComment({
      github,
      db,
      owner,
      repo: name,
      repoId,
      prNumber,
      headSha,
      jobId,
      markdown: noticeBody(
        `The LLM review could not complete (${category}). Please retry with \`/zai review\`.`,
        { manifest, headSha },
      ),
    });
    return {
      status: 'llm_failed',
      action: 'review',
      repository: repoFullName,
      issue: prNumber,
      headSha,
      errorCode: category,
    };
  }

  // --- Persist the raw response (run-output tier) + link to the run. ---
  // The artifact is best-effort audit storage: a failure here must not lose the
  // review comment. analysis_runs.result_artifact_id is its reader/index.
  let bodyArtifactId = null;
  if (env?.BOT_ARTIFACTS && runId) {
    try {
      const artifact = await writeArtifact({
        bucket: env.BOT_ARTIFACTS,
        db,
        jobId,
        runId,
        kind: 'response',
        content: result.data,
        contentType: 'text/markdown',
        extension: 'md',
      });
      bodyArtifactId = artifact.artifactId;
      await linkRunResultArtifact(db, runId, artifact.artifactId);
    } catch (artifactError) {
      logger.error('Failed to persist review artifact', {
        message: artifactError?.message,
        runId,
      });
    }
  }

  // --- Publish the review comment. ---
  await publishReviewComment({
    github,
    db,
    owner,
    repo: name,
    repoId,
    prNumber,
    headSha,
    jobId,
    bodyArtifactId,
    markdown: `## 🔍 /zai review\n\n${result.data}`,
  });

  logger.info('Review published', {
    repo: repoFullName,
    issue: prNumber,
    headSha,
    model,
    promptVersion: PROMPT_VERSION,
    artifactId: bodyArtifactId,
  });

  return {
    status: 'reviewed',
    action: 'review',
    repository: repoFullName,
    issue: prNumber,
    headSha,
    model,
    promptVersion: PROMPT_VERSION,
    contextReady: Boolean(manifest),
    artifactId: bodyArtifactId,
    usedFallback: Boolean(result.usedFallback),
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function publishReviewComment({
  github,
  db,
  owner,
  repo,
  repoId,
  prNumber,
  headSha,
  jobId,
  markdown,
  bodyArtifactId = null,
}) {
  const body = `${markdown}\n\n---\n${BOT_FOOTER}\n\n${REVIEW_MARKER}`;
  return upsertComment({
    github,
    db,
    owner,
    repo,
    issueNumber: prNumber,
    repositoryId: repoId,
    headSha,
    commentKind: 'review',
    marker: REVIEW_MARKER,
    body,
    bodyArtifactId,
    jobId,
  });
}

/** A short, marker-wrapped notice body (used on no-diff / no-key / failure). */
function noticeBody(message, { manifest, headSha }) {
  const summary = renderContextSummary(manifest);
  const head = headSha ? ` for \`${headSha.slice(0, 7)}\`` : '';
  const lines = [`## 🔍 /zai review${head}`, '', message];
  if (summary) lines.push('', summary);
  return lines.join('\n');
}

/**
 * Builds the user prompt from the gathered context. The diff is the primary
 * input (already byte-bounded); description and the file list are secondary.
 */
function buildReviewPrompt({ title, author, description, fileNames, diff }) {
  const sections = ['Review the following pull request.'];
  sections.push(`# ${title || '(untitled PR)'}`);
  if (author) sections.push(`by @${author}`);
  if (typeof description === 'string' && description.trim()) {
    sections.push('', '## Description', truncate(description.trim(), 4000));
  }
  if (fileNames && fileNames.length) {
    sections.push(
      '',
      `## Changed files (${fileNames.length})`,
      fileNames.map((f) => `- ${f}`).join('\n'),
    );
  }
  sections.push('', '## Diff', '```diff', diff, '```');
  sections.push(
    '',
    'Respond in Markdown with these sections:',
    '## Summary',
    'A 1–2 sentence overview of what this change does.',
    '## Findings',
    'Concrete issues, ordered by severity. Prefix each with **[High]**, **[Medium]**, **[Low]**, or **[Nit]**. Omit a severity that has nothing.',
    '## Notes',
    'Positive observations or non-blocking suggestions (optional).',
  );
  return sections.join('\n');
}

function truncate(text, max) {
  return text.length <= max ? text : `${text.slice(0, max)}\n…(truncated)`;
}

export function canHandle(commandType) {
  return commandType === 'review';
}
