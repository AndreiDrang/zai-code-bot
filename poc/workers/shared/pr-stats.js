export const MAX_PR_FILES_API_LIMIT = 3000;

/** Fetches changed files with a hard cap and returns a bounded manifest. */
export async function fetchPrStats(github, owner, repo, prNumber, options = {}) {
  const maxFiles = Math.min(Math.max(Number(options.maxFiles) || 100, 1), MAX_PR_FILES_API_LIMIT);
  const files = [];
  let page = 1;
  let truncated = false;

  while (files.length < maxFiles && files.length < MAX_PR_FILES_API_LIMIT) {
    const perPage = Math.min(100, maxFiles - files.length);
    const pageFiles = await github.getPrFiles(owner, repo, prNumber, page, perPage);
    if (!Array.isArray(pageFiles) || pageFiles.length === 0) break;
    for (const file of pageFiles) {
      if (files.length >= maxFiles) {
        truncated = true;
        break;
      }
      files.push({
        filename: String(file.filename || ''),
        additions: Number(file.additions) || 0,
        deletions: Number(file.deletions) || 0,
        status: String(file.status || 'modified'),
        changes: Number(file.changes) || 0,
      });
    }
    if (files.length >= maxFiles && pageFiles.length === perPage) {
      // We filled the requested safety window; a full page means more files
      // may exist, but fetching them would violate the bound.
      truncated = true;
      break;
    }
    if (pageFiles.length < perPage) break;
    page += 1;
  }

  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  return { additions, deletions, changedFiles: files.length, files, truncated };
}
