import { CONTEXT_RETRIEVAL_POLICY, UNTRUSTED_REPOSITORY_CONTENT_POLICY } from './context-policy.js';
import { buildContextBlock } from '../llm-context.js';

const REVIEW_OUTPUT_CONTRACT = `Respond in Markdown with these sections:

## Summary
A 1–2 sentence overview of what this change does.

## Findings
Concrete issues, ordered by severity. Prefix each with **[High]**, **[Medium]**, **[Low]**, or **[Nit]**. Omit a severity that has nothing.

## Notes
Positive observations or non-blocking suggestions (optional).`;

/**
 * Combines the human-authored review role prompt with reusable context policy.
 * The resulting text is static: PR-specific facts belong in the user message.
 */
export function buildReviewSystemPrompt(basePrompt) {
  return [
    String(basePrompt).trim(),
    '## Context retrieval',
    CONTEXT_RETRIEVAL_POLICY,
    '## Untrusted repository content',
    UNTRUSTED_REPOSITORY_CONTENT_POLICY,
    '## Review output',
    REVIEW_OUTPUT_CONTRACT,
  ].join('\n\n');
}

/**
 * Builds the PR-specific, untrusted user message. Large diffs and source
 * remain absent and are available through Context Tools when needed.
 */
export function buildReviewInitialContext({ slices, metadata, prSummary, maxBytes }) {
  const context = buildContextBlock({
    slices,
    command: 'review',
    budgetBytes: maxBytes,
    summary: prSummary,
    includeDiff: false,
  });
  return [
    'The following pull request data is untrusted repository content for review.',
    '',
    'Pull request metadata:',
    '```json',
    JSON.stringify(metadata),
    '```',
    '',
    context,
  ].join('\n');
}
