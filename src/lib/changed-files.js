const DEFAULT_PER_PAGE = 100;
const MAX_PR_FILES_API_LIMIT = 3000;

async function fetchAllChangedFiles(octokit, owner, repo, pullNumber, options = {}) {
  const perPage = options.perPage || DEFAULT_PER_PAGE;
  const maxFiles = options.maxFiles || MAX_PR_FILES_API_LIMIT;
  const files = [];
  let page = 1;
  let limitReached = false;

  while (files.length < maxFiles) {
    const remaining = maxFiles - files.length;
    const currentPerPage = Math.min(perPage, remaining);
    const { data } = await octokit.rest.pulls.listFiles({
      owner,
      repo,
      pull_number: pullNumber,
      per_page: currentPerPage,
      page,
    });

    const batch = Array.isArray(data) ? data : [];
    files.push(...batch);

    if (batch.length < currentPerPage) {
      return {
        files,
        pageCount: page,
        limitReached,
      };
    }

    if (files.length >= maxFiles) {
      limitReached = true;
      break;
    }

    page += 1;
  }

  return {
    files,
    pageCount: page,
    limitReached,
  };
}

async function fetchChangedFiles(octokit, owner, repo, pullNumber, options = {}) {
  const result = await fetchAllChangedFiles(octokit, owner, repo, pullNumber, options);
  return result.files;
}

module.exports = {
  fetchAllChangedFiles,
  fetchChangedFiles,
  DEFAULT_PER_PAGE,
  MAX_PR_FILES_API_LIMIT,
};
