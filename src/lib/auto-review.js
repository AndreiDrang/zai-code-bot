const {
  MAX_PR_FILES_API_LIMIT,
} = require('./changed-files');

const DEFAULT_LARGE_PR_FILE_THRESHOLD = 50;
const DEFAULT_REVIEW_BATCH_CHARS = 120000;
const DEFAULT_MAX_FILES_PER_BATCH = 40;
const DEFAULT_MAX_PATCH_CHARS = 18000;
const DEFAULT_SYNTHESIS_MAX_CHARS = 120000;

const HIGH_RISK_PATTERNS = [
  /(^|\/)(auth|security|permissions?|policy|policies)(\/|\.|$)/i,
  /(^|\/)(api|server|backend|worker|workers|db|database|migration|migrations)(\/|\.|$)/i,
  /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|action\.yml|dockerfile|docker-compose|\.github\/workflows\/)/i,
  /\.(js|cjs|mjs|ts|tsx|jsx|py|go|rs|java|cs|sql|yml|yaml)$/i,
];

function getPatchLength(file) {
  return typeof file?.patch === 'string' ? file.patch.length : 0;
}

function scoreFile(file) {
  let score = 0;
  const filename = file?.filename || '';
  const patchLength = getPatchLength(file);

  score += Math.min(40, Math.ceil(patchLength / 800));

  if (file?.status === 'added' || file?.status === 'renamed') {
    score += 8;
  }

  if (HIGH_RISK_PATTERNS.some(pattern => pattern.test(filename))) {
    score += 24;
  }

  return score;
}

function compareByPriority(a, b) {
  if (b.priority !== a.priority) {
    return b.priority - a.priority;
  }

  if (b.patchLength !== a.patchLength) {
    return b.patchLength - a.patchLength;
  }

  return a.filename.localeCompare(b.filename);
}

function splitTextByLines(text, maxChars) {
  const source = typeof text === 'string' ? text : '';
  if (!source || source.length <= maxChars) {
    return [source];
  }

  const lines = source.split('\n');
  const chunks = [];
  let current = [];
  let currentLength = 0;

  for (const line of lines) {
    const nextLength = currentLength + line.length + 1;
    if (current.length > 0 && nextLength > maxChars) {
      chunks.push(current.join('\n'));
      current = [line];
      currentLength = line.length;
      continue;
    }

    if (line.length > maxChars) {
      if (current.length > 0) {
        chunks.push(current.join('\n'));
        current = [];
        currentLength = 0;
      }

      let offset = 0;
      while (offset < line.length) {
        chunks.push(line.slice(offset, offset + maxChars));
        offset += maxChars;
      }
      continue;
    }

    current.push(line);
    currentLength = nextLength;
  }

  if (current.length > 0) {
    chunks.push(current.join('\n'));
  }

  return chunks.filter(Boolean);
}

function createReviewEntries(files, options = {}) {
  const maxPatchChars = options.maxPatchChars || DEFAULT_MAX_PATCH_CHARS;

  return (files || [])
    .filter(file => typeof file?.patch === 'string' && file.patch.length > 0)
    .flatMap((file) => {
      const chunks = splitTextByLines(file.patch, maxPatchChars);
      const priority = scoreFile(file);
      const patchLength = getPatchLength(file);

      return chunks.map((chunk, index) => ({
        filename: file.filename,
        status: file.status || 'modified',
        patch: chunk,
        chunkIndex: index + 1,
        chunkCount: chunks.length,
        priority,
        patchLength,
      }));
    })
    .sort(compareByPriority);
}

function formatEntry(entry) {
  const chunkLabel = entry.chunkCount > 1
    ? ` part="${entry.chunkIndex}/${entry.chunkCount}"`
    : '';

  return `<file name="${entry.filename}" status="${entry.status}"${chunkLabel}>\n<diff>\n${entry.patch}\n</diff>\n</file>`;
}

function createReviewBatches(files, options = {}) {
  const maxBatchChars = options.maxBatchChars || DEFAULT_REVIEW_BATCH_CHARS;
  const maxFilesPerBatch = options.maxFilesPerBatch || DEFAULT_MAX_FILES_PER_BATCH;
  const entries = createReviewEntries(files, options);
  const batches = [];
  let currentEntries = [];
  let currentChars = 0;
  let currentFiles = new Set();

  for (const entry of entries) {
    const formatted = formatEntry(entry);
    const nextDistinctFiles = currentFiles.has(entry.filename)
      ? currentFiles.size
      : currentFiles.size + 1;
    const exceedsChars = currentEntries.length > 0 && currentChars + formatted.length > maxBatchChars;
    const exceedsFiles = currentEntries.length > 0 && nextDistinctFiles > maxFilesPerBatch;

    if (exceedsChars || exceedsFiles) {
      batches.push(currentEntries);
      currentEntries = [];
      currentChars = 0;
      currentFiles = new Set();
    }

    currentEntries.push(entry);
    currentChars += formatted.length;
    currentFiles.add(entry.filename);
  }

  if (currentEntries.length > 0) {
    batches.push(currentEntries);
  }

  const splitFileCount = new Set(entries.filter(entry => entry.chunkCount > 1).map(entry => entry.filename)).size;

  return {
    entries,
    batches,
    metadata: {
      totalPatchableFiles: (files || []).filter(file => typeof file?.patch === 'string' && file.patch.length > 0).length,
      totalEntries: entries.length,
      splitFileCount,
      totalBatches: batches.length,
    },
  };
}

function buildPrompt(entries, options = {}) {
  const batchNumber = options.batchNumber || 1;
  const totalBatches = options.totalBatches || 1;
  const totalFiles = new Set(entries.map(entry => entry.filename)).size;
  const formattedFiles = entries.map(formatEntry).join('\n\n');

  return `Please review the following Pull Request changes based on your system instructions.\n\nThis is batch ${batchNumber} of ${totalBatches}. Review all files in this batch thoroughly, but do not assume the rest of the PR is included here. Focus on concrete bugs, security issues, risky logic, and architecture mismatches visible in these diffs.\n\n<review_batch file_count="${totalFiles}" chunk_count="${entries.length}" batch_number="${batchNumber}" total_batches="${totalBatches}">\n${formattedFiles}\n</review_batch>`;
}

function buildSynthesisPrompt(batchReviews, metadata = {}, options = {}) {
  const maxChars = options.maxChars || DEFAULT_SYNTHESIS_MAX_CHARS;
  const sections = batchReviews.map((review, index) => {
    const coverage = review.coverage || {};
    const header = `## Batch ${index + 1}\nFiles: ${coverage.fileCount || 0}\nChunks: ${coverage.entryCount || 0}`;
    return `${header}\n\n${review.review}`;
  }).join('\n\n---\n\n');

  const basePrompt = `You are consolidating partial code reviews from multiple batches of the same Pull Request into one final review.\n\nCoverage summary:\n- Patchable files reviewed: ${metadata.reviewedFiles || 0}\n- Review batches: ${metadata.totalBatches || batchReviews.length}\n- Split files: ${metadata.splitFileCount || 0}\n- GitHub PR file limit reached: ${metadata.limitReached ? 'yes' : 'no'}\n\nRequirements:\n1. Deduplicate overlapping findings from different batches.\n2. Preserve serious issues and concrete file references when available.\n3. Be explicit if coverage is incomplete because the GitHub API file listing limit was reached.\n4. Use the exact markdown structure below.\n\n**## Review Summary**\n[1-2 sentences]\n\n**## Critical Issues & Bugs**\n* [File Name]: [Issue]\n\n**## Suggestions & Best Practices**\n* [File Name]: [Suggestion]\n\n**## Coverage Notes**\n* [Coverage note]\n\n**## Final Assessment**\n* **Rating:** [Good|Normal|Very Bad]\n* **Reason:** [1-2 sentences]\n\nSource batch reviews:\n\n${sections}`;

  if (basePrompt.length <= maxChars) {
    return basePrompt;
  }

  return `${basePrompt.slice(0, maxChars)}\n\n...[truncated batch review synthesis input]`;
}

function buildCoverageNotes(metadata = {}) {
  const notes = [];
  notes.push(`Reviewed ${metadata.reviewedFiles || 0} patchable file(s) across ${metadata.totalBatches || 0} batch(es).`);

  if (metadata.splitFileCount) {
    notes.push(`${metadata.splitFileCount} large file(s) were split across multiple review chunks to stay within model limits.`);
  }

  if (metadata.limitReached) {
    notes.push(`GitHub's changed-files API limit of ${MAX_PR_FILES_API_LIMIT} files was reached, so files beyond that platform limit could not be reviewed.`);
  }

  return notes;
}

function buildFallbackReview(batchReviews, metadata = {}) {
  const coverageNotes = buildCoverageNotes(metadata)
    .map(note => `* ${note}`)
    .join('\n');
  const sections = batchReviews.map((review, index) => `### Batch ${index + 1}\n\n${review.review}`).join('\n\n');

  return `## Review Summary\nBatched auto-review completed for a large pull request. The review below merges batch-level findings when final synthesis is unavailable.\n\n## Critical Issues & Bugs\nNone detected.\n\n## Suggestions & Best Practices\nNone detected.\n\n## Coverage Notes\n${coverageNotes}\n\n## Final Assessment\n* **Rating:** Normal\n* **Reason:** The PR required batched review due to size. See per-batch findings below for detailed analysis.\n\n${sections}`;
}

function isLargePr(files, options = {}) {
  const threshold = options.largePrFileThreshold || DEFAULT_LARGE_PR_FILE_THRESHOLD;
  const patchableFiles = (files || []).filter(file => typeof file?.patch === 'string' && file.patch.length > 0);
  return patchableFiles.length > threshold;
}

function isContextLimitError(error) {
  const message = String(error?.message || '').toLowerCase();
  return message.includes('maximum context length')
    || message.includes('input tokens exceeds')
    || message.includes('code":413')
    || message.includes('type":"413');
}

module.exports = {
  DEFAULT_LARGE_PR_FILE_THRESHOLD,
  DEFAULT_REVIEW_BATCH_CHARS,
  DEFAULT_MAX_FILES_PER_BATCH,
  DEFAULT_MAX_PATCH_CHARS,
  DEFAULT_SYNTHESIS_MAX_CHARS,
  buildCoverageNotes,
  buildFallbackReview,
  buildPrompt,
  buildSynthesisPrompt,
  compareByPriority,
  createReviewBatches,
  createReviewEntries,
  formatEntry,
  isContextLimitError,
  isLargePr,
  scoreFile,
  splitTextByLines,
};
