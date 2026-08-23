import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PR_SUMMARY_PROMPT, REVIEW_PROMPT } from '../zai-heavy-worker/generated/prompts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workerRoot = path.resolve(__dirname, '../zai-heavy-worker');

describe('prompt generation (committed generated/ in sync with prompts/)', () => {
  it('exports REVIEW_PROMPT matching the source review.txt verbatim', () => {
    const source = readFileSync(path.join(workerRoot, 'prompts', 'review.txt'), 'utf8');
    expect(REVIEW_PROMPT).toBe(source);
  });

  it('is a non-empty, instruction-style system prompt', () => {
    expect(REVIEW_PROMPT.length).toBeGreaterThan(200);
    expect(REVIEW_PROMPT.toLowerCase()).toContain('code reviewer');
    expect(REVIEW_PROMPT.toLowerCase()).toContain('markdown');
  });

  it('exports PR_SUMMARY_PROMPT matching the source pr-summary.txt verbatim', () => {
    const source = readFileSync(path.join(workerRoot, 'prompts', 'pr-summary.txt'), 'utf8');
    expect(PR_SUMMARY_PROMPT).toBe(source);
    expect(PR_SUMMARY_PROMPT).toContain('valid JSON only');
  });
});
