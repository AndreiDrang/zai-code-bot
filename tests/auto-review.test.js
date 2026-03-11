import { test, describe, expect } from 'vitest';

const {
  buildCoverageNotes,
  buildFallbackReview,
  createReviewBatches,
  createReviewEntries,
  formatEntry,
  isContextLimitError,
  isLargePr,
  splitTextByLines,
} = require('../src/lib/auto-review');

describe('auto-review helpers', () => {
  test('splitTextByLines breaks large patches into bounded chunks', () => {
    const chunks = splitTextByLines('line1\nline2\nline3\nline4', 11);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every(chunk => chunk.length <= 11)).toBe(true);
  });

  test('createReviewEntries splits large files and preserves metadata', () => {
    const entries = createReviewEntries([
      { filename: 'src/auth.js', status: 'modified', patch: 'a\n'.repeat(20) }
    ], { maxPatchChars: 15 });

    expect(entries.length).toBeGreaterThan(1);
    expect(entries[0].filename).toBe('src/auth.js');
    expect(entries.every(entry => entry.chunkCount === entries[0].chunkCount)).toBe(true);
  });

  test('createReviewBatches respects file and character limits', () => {
    const result = createReviewBatches([
      { filename: 'a.js', patch: '+a\n'.repeat(10) },
      { filename: 'b.js', patch: '+b\n'.repeat(10) },
      { filename: 'c.js', patch: '+c\n'.repeat(10) },
    ], { maxBatchChars: 80, maxFilesPerBatch: 2, maxPatchChars: 100 });

    expect(result.batches.length).toBeGreaterThan(1);
    expect(result.metadata.totalPatchableFiles).toBe(3);
  });

  test('formatEntry includes chunk metadata when file is split', () => {
    const formatted = formatEntry({
      filename: 'src/index.js',
      status: 'modified',
      patch: '+x',
      chunkIndex: 2,
      chunkCount: 3,
    });

    expect(formatted.includes('part="2/3"')).toBe(true);
  });

  test('buildCoverageNotes reports split files and platform ceiling', () => {
    const notes = buildCoverageNotes({
      reviewedFiles: 120,
      totalBatches: 4,
      splitFileCount: 3,
      limitReached: true,
    });

    expect(notes.some(note => note.includes('120'))).toBe(true);
    expect(notes.some(note => note.includes('3 large file'))).toBe(true);
    expect(notes.some(note => note.includes('3000 files'))).toBe(true);
  });

  test('buildFallbackReview includes batch sections and coverage notes', () => {
    const review = buildFallbackReview([
      { review: 'Batch one review' },
      { review: 'Batch two review' },
    ], {
      reviewedFiles: 2,
      totalBatches: 2,
      splitFileCount: 1,
      limitReached: false,
    });

    expect(review.includes('### Batch 1')).toBe(true);
    expect(review.includes('### Batch 2')).toBe(true);
    expect(review.includes('Coverage Notes')).toBe(true);
  });

  test('isLargePr uses patchable file count threshold', () => {
    expect(isLargePr([{ filename: 'a.js', patch: '+a' }, { filename: 'b.js', patch: '+b' }], { largePrFileThreshold: 1 })).toBe(true);
    expect(isLargePr([{ filename: 'a.js', patch: '+a' }, { filename: 'b.js' }], { largePrFileThreshold: 1 })).toBe(false);
  });

  test('isContextLimitError detects provider token-limit errors', () => {
    expect(isContextLimitError(new Error('Z.ai API error 400: {"error":{"message":"Request input tokens exceeds the model maximum context length","code":413}}'))).toBe(true);
    expect(isContextLimitError(new Error('network error'))).toBe(false);
  });
});
