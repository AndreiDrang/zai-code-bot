import { buildContextBlock } from '../../../shared/llm-context.js';
import { readContextManifest, readContextSlice } from '../../../shared/pr-context-reader.js';
import { createLogger } from '../../../shared/logging.js';
import { getRepositoryConfig } from '../../../shared/storage/config.js';
import { prSummaryKey } from '../../../shared/storage/keys.js';
import { resolveSecretValue } from '../../../shared/secrets.js';
import { createZaiClient } from '../../../shared/zai-client.js';
import { PR_SUMMARY_PROMPT } from '../../generated/prompts.js';

const PROMPT_VERSION = 'pr-summary-v1';
const DEFAULT_MAX_CONTEXT_BYTES = 200000;
const FALLBACK_MAX_CONTEXT_BYTES = 60000;
const MODEL_TIMEOUT_MS = 45000;
const MODEL_MAX_RETRIES = 3;
const MODEL_BASE_DELAY_MS = 2000;

/**
 * Generates the structured initial PR context after `pr_context` has written
 * all source slices. This job deliberately does not publish a GitHub comment:
 * the JSON artifact is auxiliary context for later `/zai review` runs.
 */
export async function handlePrSummaryJob({ env, db, job }) {
  const logger = createLogger(env, 'zai-heavy-worker:pr-summary');
  const {
    repository_id: repoId,
    pr_number: prNumber,
    head_sha: headSha,
    title,
    author_login: author,
    repository_full_name: repoFullName,
  } = job;

  const bucket = env?.BOT_ARTIFACTS;
  const manifest = await readContextManifest(bucket, repoId, prNumber);
  if (!manifest) {
    const error = new Error('PR context manifest is missing');
    error.code = 'pr_summary_context_stale';
    error.retryable = true;
    throw error;
  }
  if (manifest.headSha !== headSha) {
    return {
      status: 'stale',
      action: 'pr_summary',
      repository: repoFullName,
      issue: prNumber,
      headSha,
      currentHeadSha: manifest.headSha,
    };
  }

  const [description, commits, files, comments, diff] = await Promise.all([
    readContextSlice(bucket, repoId, prNumber, 'description'),
    readContextSlice(bucket, repoId, prNumber, 'commits'),
    readContextSlice(bucket, repoId, prNumber, 'files'),
    readContextSlice(bucket, repoId, prNumber, 'comments'),
    readContextSlice(bucket, repoId, prNumber, 'diff'),
  ]);
  const slices = { description, commits, files, comments, diff };
  const config = await getRepositoryConfig(db, env?.BOT_CACHE, repoId);
  const maxBytes = Number(config?.maxContextBytes) || DEFAULT_MAX_CONTEXT_BYTES;
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

  const userContent = buildPrSummaryUserPrompt({
    slices,
    meta: { title: title || manifest.title, author: author || manifest.authorLogin },
    manifest,
    maxBytes,
  });
  const fallbackMaxBytes = Math.min(maxBytes, FALLBACK_MAX_CONTEXT_BYTES);
  const fallbackUserContent =
    fallbackMaxBytes < maxBytes
      ? buildPrSummaryUserPrompt({
          slices,
          meta: { title: title || manifest.title, author: author || manifest.authorLogin },
          manifest,
          maxBytes: fallbackMaxBytes,
        })
      : null;
  const model = env?.ZAI_MODEL || 'glm-5.2';
  const client = createZaiClient({
    timeout: MODEL_TIMEOUT_MS,
    maxRetries: MODEL_MAX_RETRIES,
    baseDelay: MODEL_BASE_DELAY_MS,
  });
  const result = await client.call({
    apiKey,
    model,
    messages: [
      { role: 'system', content: PR_SUMMARY_PROMPT },
      { role: 'user', content: userContent },
    ],
    fallbackMessages: fallbackUserContent
      ? [
          { role: 'system', content: PR_SUMMARY_PROMPT },
          { role: 'user', content: fallbackUserContent },
        ]
      : undefined,
  });

  if (!result.success) {
    const category = String(result.error?.category || 'internal').replace(/[^a-z0-9_]/gi, '_');
    const error = new Error(`PR summary LLM call failed: ${category}`);
    error.code = `pr_summary_${category}`;
    error.retryable = result.error?.retryable !== false;
    throw error;
  }

  let summary;
  try {
    summary = validatePrSummary(JSON.parse(String(result.data)));
  } catch (error) {
    const invalid = new Error('Z.ai returned an invalid PR summary');
    invalid.code = 'pr_summary_invalid_json';
    invalid.retryable = true;
    invalid.cause = error;
    throw invalid;
  }

  // A newer synchronize event may have replaced the manifest while the model
  // was running. Never let an older answer overwrite the current summary.
  const latestManifest = await readContextManifest(bucket, repoId, prNumber);
  if (!latestManifest || latestManifest.headSha !== headSha) {
    logger.warn('Discarded stale PR summary', {
      repo: repoFullName,
      issue: prNumber,
      headSha,
      currentHeadSha: latestManifest?.headSha || null,
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
    sourceManifestUpdatedAt: manifest.gatheredAt || null,
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
  });
  return {
    status: 'success',
    action: 'pr_summary',
    repository: repoFullName,
    issue: prNumber,
    headSha,
    model,
    promptVersion: PROMPT_VERSION,
  };
}

function buildPrSummaryUserPrompt({ slices, meta, manifest, maxBytes }) {
  const context = buildContextBlock({
    slices,
    command: 'pr-summary',
    budgetBytes: maxBytes,
    meta,
  });
  const aggregates = manifest?.aggregates || {};
  const counts = manifest?.counts || {};
  return [
    'Create a compact, factual context summary for this pull request.',
    'This summary will be used as background for future automated code reviews.',
    '',
    `Pull request title:\n${meta?.title || '(unknown)'}`,
    `\nPull request author:\n${meta?.author || '(unknown)'}`,
    `\nBase commit:\n${manifest?.baseSha || '(unknown)'}`,
    `\nHead commit:\n${manifest?.headSha || '(unknown)'}`,
    `\nFiles changed: ${counts.files || 0} (+${aggregates.additions || 0}/-${
      aggregates.deletions || 0
    })`,
    '',
    context || '(No source context was available.)',
    '',
    'Return exactly this JSON structure:',
    '{',
    '  "prSummary": "A concise description of what changed and why.",',
    '  "keyChanges": [',
    '    {',
    '      "file": "path/to/file",',
    '      "change": "Concise description of the change in this file."',
    '    }',
    '  ],',
    '  "conversationSummary": {',
    '    "mainTopic": "The primary discussion topic, or null when there was no meaningful discussion.",',
    '    "unresolvedQuestions": [',
    '      "A question that remains unresolved in the provided discussion."',
    '    ],',
    '    "resolvedQuestions": 0',
    '  }',
    '}',
  ].join('\n');
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
