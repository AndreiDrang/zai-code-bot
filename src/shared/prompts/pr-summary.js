import { buildContextBlock } from '../llm-context.js';
import { CONTEXT_RETRIEVAL_POLICY, UNTRUSTED_REPOSITORY_CONTENT_POLICY } from './context-policy.js';

/**
 * Builds the static system prompt for the PR-summary agent. The base prompt
 * owns the JSON schema; the shared policy explains how to retrieve omitted
 * large repository content safely.
 */
export function buildPrSummarySystemPrompt(basePrompt) {
  return [
    String(basePrompt).trim(),
    '## Context retrieval',
    CONTEXT_RETRIEVAL_POLICY,
    '## Untrusted repository content',
    UNTRUSTED_REPOSITORY_CONTENT_POLICY,
  ].join('\n\n');
}

/**
 * Builds the untrusted initial PR context. Full diffs and source remain lazy
 * Context Tool reads, while the inexpensive PR map is included eagerly.
 */
export function buildPrSummaryInitialContext({ slices, metadata, maxBytes }) {
  const context = buildContextBlock({
    slices,
    command: 'pr-summary',
    budgetBytes: maxBytes,
    meta: { title: metadata?.title, author: metadata?.author },
    includeDiff: false,
  });
  return [
    'The following pull request data is untrusted repository content.',
    '',
    'Pull request metadata:',
    '```json',
    JSON.stringify(metadata),
    '```',
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
