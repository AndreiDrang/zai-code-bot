/**
 * GitHub API Client for Cloudflare Workers.
 *
 * NOTE: webhook signature verification was extracted to `./crypto.js`
 * (Web Crypto API). This module is pure REST I/O and is shared by both workers.
 */

const GITHUB_API_BASE = 'https://api.github.com';

export class GitHubClient {
  /**
   * @param {string} token - GitHub Personal Access Token
   * @param {Object} [opts]
   * @param {string} [opts.userAgent='zai-code-bot-workers']
   */
  constructor(token, opts = {}) {
    this.token = token;
    this.baseUrl = GITHUB_API_BASE;
    this.userAgent = opts.userAgent || 'zai-code-bot-workers';
  }

  /**
   * Generic GitHub API request.
   * @param {string} method
   * @param {string} path
   * @param {Object} [data]
   * @param {Object} [opts] - e.g. { returnText: true } for raw diffs
   * @returns {Promise<Object|string>}
   */
  async request(method, path, data = null, opts = {}) {
    const url = `${this.baseUrl}${path}`;

    const options = {
      method,
      headers: {
        Authorization: `token ${this.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': this.userAgent,
      },
    };

    if (data) {
      options.body = JSON.stringify(data);
    }
    if (opts.accept) {
      options.headers.Accept = opts.accept;
    }

    const response = await fetch(url, options);

    if (!response.ok) {
      const body = await response.text();
      const err = new Error(`GitHub API error: ${response.status}`);
      err.status = response.status;
      err.body = body;
      throw err;
    }

    // 204 No Content (e.g. the collaborator check) and other empty 2xx bodies
    // have no JSON to parse — calling response.json() throws
    // "Unexpected end of JSON input". Read once as text and short-circuit.
    const text = await response.text();
    if (text === '') return null;
    if (opts.returnText) return text;
    try {
      return JSON.parse(text);
    } catch (parseErr) {
      // Preserve the request() error contract (callers check error.status)
      // and surface a debuggable error instead of a bare SyntaxError.
      const err = new Error(`GitHub API returned ${response.status} with non-JSON body`);
      err.status = response.status;
      err.body = text.slice(0, 500);
      err.cause = parseErr;
      throw err;
    }
  }

  /** Repository metadata. */
  getRepository(owner, repo) {
    return this.request('GET', `/repos/${owner}/${repo}`);
  }

  /** Posts a comment to an issue or PR. */
  postComment(owner, repo, issueNumber, body) {
    return this.request('POST', `/repos/${owner}/${repo}/issues/${issueNumber}/comments`, { body });
  }

  /** Lists issue/PR comments; pagination is handled by the caller. */
  getIssueComments(owner, repo, issueNumber, page = 1, perPage = 100) {
    return this.request(
      'GET',
      `/repos/${owner}/${repo}/issues/${issueNumber}/comments?page=${page}&per_page=${perPage}`,
    );
  }

  /** Updates an existing issue/PR comment. */
  updateComment(owner, repo, commentId, body) {
    return this.request('PATCH', `/repos/${owner}/${repo}/issues/comments/${commentId}`, { body });
  }

  /** User profile. */
  getUser(username) {
    return this.request('GET', `/users/${username}`);
  }

  /** Issue info. */
  getIssue(owner, repo, issueNumber) {
    return this.request('GET', `/repos/${owner}/${repo}/issues/${issueNumber}`);
  }

  /** Pull request info. */
  getPullRequest(owner, repo, prNumber) {
    return this.request('GET', `/repos/${owner}/${repo}/pulls/${prNumber}`);
  }

  /** Pull request changed files (paginated by the caller). */
  getPrFiles(owner, repo, prNumber, page = 1, perPage = 100) {
    return this.request(
      'GET',
      `/repos/${owner}/${repo}/pulls/${prNumber}/files?page=${page}&per_page=${perPage}`,
    );
  }

  /** Raw unified diff of a PR (Accept: GitHub diff media type). */
  getPrDiff(owner, repo, prNumber) {
    return this.request('GET', `/repos/${owner}/${repo}/pulls/${prNumber}`, null, {
      accept: 'application/vnd.github.v3.diff',
      returnText: true,
    });
  }

  /** Commits on a PR (paginated by the caller). */
  getPrCommits(owner, repo, prNumber, page = 1, perPage = 100) {
    return this.request(
      'GET',
      `/repos/${owner}/${repo}/pulls/${prNumber}/commits?page=${page}&per_page=${perPage}`,
    );
  }

  /** Inline review comments on a PR (paginated by the caller). */
  getReviewComments(owner, repo, prNumber, page = 1, perPage = 100) {
    return this.request(
      'GET',
      `/repos/${owner}/${repo}/pulls/${prNumber}/comments?page=${page}&per_page=${perPage}`,
    );
  }

  /** PR description (the `body` of the pull request). */
  async getPrDescription(owner, repo, prNumber) {
    const pr = await this.getPullRequest(owner, repo, prNumber);
    return pr?.body ?? '';
  }

  /**
   * Conversation on a PR: issue-level comments (top of thread) + inline review
   * comments. Each list is capped at `maxComments`; the caller budgets bytes.
   * Returns `{ issue: [...], review: [...] }`.
   */
  async getPrComments(owner, repo, prNumber, { maxComments = 100 } = {}) {
    const perPage = Math.min(Math.max(Number(maxComments) || 100, 1), 100);
    const [issue, review] = await Promise.all([
      this.getIssueComments(owner, repo, prNumber, 1, perPage).catch(() => []),
      this.getReviewComments(owner, repo, prNumber, 1, perPage).catch(() => []),
    ]);
    return {
      issue: Array.isArray(issue) ? issue.slice(0, perPage) : [],
      review: Array.isArray(review) ? review.slice(0, perPage) : [],
    };
  }

  /** Raw file content at a ref (returns text). */
  getFileContent(owner, repo, path, ref) {
    const qs = ref ? `?ref=${encodeURIComponent(ref)}` : '';
    return this.request(
      'GET',
      `/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}${qs}`,
      null,
      {
        accept: 'application/vnd.github.raw',
        returnText: true,
      },
    );
  }
}
